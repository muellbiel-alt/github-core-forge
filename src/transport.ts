// Raw-TCP HTTP/1.1 transport for the forge — a hand-rolled request parser + response
// serializer that drives the SAME handler the node:http server drives. It exists because
// the perf workloads are dominated by per-request HTTP overhead on both sides of the wire
// (undici's client machinery AND node:http's parser + object churn); a minimal parser
// that extracts only the headers the handlers read (authorization, git-protocol, host,
// content-length, transfer-encoding, connection) cuts that overhead materially.
// The handlers (src/rest.ts, src/git.ts, src/graphql.ts, src/mcp.ts, src/store.ts) are
// NOT touched — this module only adapts the wire shape to the node:http shape they expect.
// It takes the handler as a parameter and imports nothing from app.ts at runtime, so
// there is no import cycle with the module that builds the handler.
import { createServer as createTcpServer, type Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeServer } from '../app.ts';

const EMPTY_BUF = Buffer.alloc(0);
const CRLFCRLF = Buffer.from('\r\n\r\n', 'ascii');

const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

type ReqListener = (chunk?: Buffer) => void;

/** Duck-typed IncomingMessage: only the surface the handler touches (method, url, headers,
 * on('data'/'end'/'error')). */
class FakeReq {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  private dataCb: ReqListener | null = null;
  private endCb: ReqListener | null = null;
  private errorCb: ReqListener | null = null;

  constructor(method: string, url: string, headers: Record<string, string | undefined>) {
    this.method = method;
    this.url = url;
    this.headers = headers;
  }

  on(event: 'data' | 'end' | 'error', cb: ReqListener): void {
    if (event === 'data') this.dataCb = cb;
    else if (event === 'end') this.endCb = cb;
    else this.errorCb = cb;
  }

  /** Deliver the fully-buffered body, then end — exactly as node:http would for a request
   * whose body arrived complete. */
  emitBody(body: Buffer): void {
    if (this.dataCb !== null && body.length > 0) this.dataCb(body);
    if (this.endCb !== null) this.endCb();
  }

  emitError(): void {
    if (this.errorCb !== null) this.errorCb();
  }
}

/** Duck-typed ServerResponse: only the surface the handler touches (writeHead, end,
 * headersSent). Buffers the status line + headers from writeHead and serializes the whole
 * response in ONE sock.write() at end(), so each request costs exactly one write syscall. */
class FakeRes {
  headersSent = false;
  private status = 200;
  private headerLines: string[] = [];
  private flushed = false;
  private readonly sock: Socket;
  private readonly isHead: boolean;
  private readonly closeAfter: boolean;

  constructor(sock: Socket, isHead: boolean, closeAfter: boolean) {
    this.sock = sock;
    this.isHead = isHead;
    this.closeAfter = closeAfter;
  }

  writeHead(
    status: number,
    statusMessageOrHeaders?: string | Record<string, string | number>,
    headers?: Record<string, string | number>,
  ): void {
    const hdrs = typeof statusMessageOrHeaders === 'string' ? headers : statusMessageOrHeaders;
    this.status = status;
    this.headersSent = true;
    this.headerLines = [];
    if (hdrs !== undefined) {
      for (const k of Object.keys(hdrs)) this.headerLines.push(`${k}: ${hdrs[k]}`);
    }
  }

  end(data?: Buffer | string): void {
    if (this.flushed) return;
    this.flushed = true;
    const body = data === undefined ? EMPTY_BUF : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let head = `HTTP/1.1 ${this.status} ${REASON[this.status] ?? ''}\r\n`;
    for (const line of this.headerLines) head += `${line}\r\n`;
    head += `connection: ${this.closeAfter ? 'close' : 'keep-alive'}\r\n\r\n`;
    const headBuf = Buffer.from(head, 'ascii');
    // HEAD responses carry headers only (node:http suppresses the body); every other
    // method sends headers + body in a single write.
    if (this.isHead) this.sock.write(headBuf);
    else this.sock.write(Buffer.concat([headBuf, body]));
  }
}

interface ParsedRequest {
  method: string;
  url: string;
  version: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  rest: Buffer;
  closeAfter: boolean;
}

/** Parse one complete HTTP/1.1 request out of `buf`, or null when more bytes are needed.
 * Throws on a malformed request line / framing (the caller destroys the socket). */
function tryParseRequest(buf: Buffer): ParsedRequest | null {
  const headEnd = buf.indexOf(CRLFCRLF);
  if (headEnd < 0) return null;
  const head = buf.subarray(0, headEnd).toString('ascii');
  const lineEnd = head.indexOf('\r\n');
  const reqLine = lineEnd < 0 ? head : head.slice(0, lineEnd);
  const sp1 = reqLine.indexOf(' ');
  if (sp1 <= 0) throw new Error('malformed request line');
  const sp2 = reqLine.indexOf(' ', sp1 + 1);
  if (sp2 < 0) throw new Error('malformed request line');
  const method = reqLine.slice(0, sp1);
  const url = reqLine.slice(sp1 + 1, sp2);
  const version = reqLine.slice(sp2 + 1);
  // Headers: keep only the ones the handler reads (plus body framing).
  const headers: Record<string, string | undefined> = {};
  let pos = lineEnd < 0 ? head.length : lineEnd + 2;
  while (pos < head.length) {
    const eol = head.indexOf('\r\n', pos);
    const line = eol < 0 ? head.slice(pos) : head.slice(pos, eol);
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).toLowerCase();
      if (
        name === 'authorization' ||
        name === 'git-protocol' ||
        name === 'host' ||
        name === 'content-length' ||
        name === 'transfer-encoding' ||
        name === 'connection'
      ) {
        headers[name] = line.slice(colon + 1).trim();
      }
    }
    if (eol < 0) break;
    pos = eol + 2;
  }
  const bodyStart = headEnd + 4;
  const connection = headers.connection;
  const closeAfter = connection !== undefined ? connection.toLowerCase() === 'close' : version === 'HTTP/1.0';
  // Body framing: chunked wins over content-length per RFC 9112 §6.3.
  const te = headers['transfer-encoding'];
  if (te !== undefined && te.toLowerCase().indexOf('chunked') >= 0) {
    const chunks: Buffer[] = [];
    let p = bodyStart;
    for (;;) {
      const lenEnd = buf.indexOf('\r\n', p);
      if (lenEnd < 0) return null;
      const sizeLine = buf.subarray(p, lenEnd).toString('ascii');
      const semi = sizeLine.indexOf(';');
      const size = Number.parseInt(semi < 0 ? sizeLine : sizeLine.slice(0, semi), 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk size');
      const dataStart = lenEnd + 2;
      if (size === 0) {
        // Trailers (if any) run to an empty line; the suite never sends them.
        let t = dataStart;
        for (;;) {
          const e = buf.indexOf('\r\n', t);
          if (e < 0) return null;
          if (e === t) {
            t = e + 2;
            break;
          }
          t = e + 2;
        }
        const body = chunks.length === 0 ? EMPTY_BUF : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
        return { method, url, version, headers, body, rest: buf.subarray(t), closeAfter };
      }
      if (buf.length < dataStart + size + 2) return null;
      chunks.push(buf.subarray(dataStart, dataStart + size));
      p = dataStart + size + 2; // skip the CRLF after the chunk data
    }
  }
  const clenRaw = headers['content-length'];
  const clen = clenRaw === undefined ? 0 : Number.parseInt(clenRaw, 10);
  if (!Number.isFinite(clen) || clen < 0) throw new Error('malformed content-length');
  if (buf.length < bodyStart + clen) return null;
  const body = clen === 0 ? EMPTY_BUF : buf.subarray(bodyStart, bodyStart + clen);
  return { method, url, version, headers, body, rest: buf.subarray(bodyStart + clen), closeAfter };
}

type ForgeHandler = (req: IncomingMessage, res: ServerResponse) => void;

function dispatchRequest(sock: Socket, req: ParsedRequest, handleRequest: ForgeHandler): void {
  const fakeReq = new FakeReq(req.method, req.url, req.headers);
  const fakeRes = new FakeRes(sock, req.method === 'HEAD', req.closeAfter);
  handleRequest(fakeReq as unknown as IncomingMessage, fakeRes as unknown as ServerResponse);
  fakeReq.emitBody(req.body);
}

/** Build the forge server on a raw TCP socket (HTTP/1.1, keep-alive, content-length +
 * chunked bodies, pipelined requests in one chunk). The wire format is the only thing
 * that changes; the handler, the store and the responses are identical to createApp. */
export function createRawServer(handleRequest: ForgeHandler): ForgeServer {
  const server = createTcpServer((sock) => {
    sock.setNoDelay(true);
    let buf: Buffer = EMPTY_BUF;
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        let parsed: ParsedRequest | null;
        try {
          parsed = tryParseRequest(buf);
        } catch {
          sock.destroy();
          return;
        }
        if (parsed === null) {
          if (buf.length > 65536) sock.destroy();
          break;
        }
        buf = parsed.rest;
        dispatchRequest(sock, parsed, handleRequest);
        if (parsed.closeAfter) {
          sock.end();
          return;
        }
      }
    });
    sock.on('error', () => {
      sock.destroy();
    });
  });
  // The raw transport has no timeouts by design (matching requestTimeout = 0); the three
  // timeout fields exist only so main.ts can set them the same way it sets them on the
  // node:http server.
  const forge: ForgeServer = {
    keepAliveTimeout: 0,
    headersTimeout: 0,
    requestTimeout: 0,
    once(event: 'error', cb: (err: Error) => void): void {
      server.once(event, cb);
    },
    listen(port: number, host?: string, cb?: () => void): void {
      if (typeof host === 'function') server.listen(port, host as unknown as () => void);
      else if (host === undefined) server.listen(port, cb ?? (() => {}));
      else server.listen(port, host, cb ?? (() => {}));
    },
    address() {
      return server.address();
    },
    close(cb?: () => void): void {
      server.close(cb);
    },
  };
  return forge;
}
