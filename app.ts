import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitRequest } from './src/git.ts';
import { handleGraphqlRequest } from './src/graphql.ts';
import { handleMcpRequest } from './src/mcp.ts';
import { handleRestRequest } from './src/rest.ts';
import { ForgeStore } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const HEALTHZ_BUF = Buffer.from('{"ok":true}\n', 'utf8');
const UNAUTH_BUF = Buffer.from('{"message":"Requires authentication"}\n', 'utf8');
const NOT_FOUND_BUF = Buffer.from('{"message":"Not Found"}\n', 'utf8');
const EMPTY_BUF = Buffer.alloc(0);
const EMPTY_QUERY = new URLSearchParams();
const GIT_ROUTE_RE = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/;

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  const space = auth.indexOf(' ');
  if (space <= 0) return false;
  if (auth.slice(0, space).toLowerCase() !== 'bearer') return false;
  return auth.slice(space + 1) === expectedToken;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) resolve(EMPTY_BUF);
      else if (chunks.length === 1) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendStaticJson(res: ServerResponse, status: number, buf: Buffer, reqId?: string): void {
  const headers: Record<string, string | number> = {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
  };
  if (reqId !== undefined) headers['x-github-request-id'] = reqId;
  res.writeHead(status, headers);
  res.end(buf);
}

/** Build the deterministic in-memory forge HTTP server. */
export function createApp(): Server {
  const store = new ForgeStore(process.env.MAKEFUN_TRIAL_NOW);
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx < 0 ? rawUrl : rawUrl.slice(0, qIdx);
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/healthz') {
      sendStaticJson(res, 200, HEALTHZ_BUF);
      return;
    }

    const reqId = store.nextRequestId();
    if (!isAuthorized(req, expectedToken)) {
      sendStaticJson(res, 401, UNAUTH_BUF, reqId);
      return;
    }

    const query = qIdx < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIdx + 1));

    const dispatch = (body: Buffer): void => {
      try {
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          handleRestRequest(store, req, res, pathname, query, body, reqId);
          return;
        }
        if (pathname === '/api/graphql') {
          handleGraphqlRequest(store, req, res, body, reqId);
          return;
        }
        if (pathname === '/mcp') {
          handleMcpRequest(store, req, res, body, reqId);
          return;
        }
        const gitMatch = GIT_ROUTE_RE.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const subpath = gitMatch[3]!;
          handleGitRequest(store, req, res, owner, repoName, subpath, query, body);
          return;
        }
        sendStaticJson(res, 404, NOT_FOUND_BUF, reqId);
      } catch (err) {
        if (!res.headersSent) {
          const msg = err instanceof Error ? err.message : 'Internal Server Error';
          const errBuf = Buffer.from(`${JSON.stringify({ message: msg })}\n`, 'utf8');
          sendStaticJson(res, 500, errBuf, reqId);
        } else {
          res.end();
        }
      }
    };

    if (method === 'GET' || method === 'HEAD') {
      dispatch(EMPTY_BUF);
      return;
    }

    readBody(req)
      .then(dispatch)
      .catch(() => {
        if (!res.headersSent) sendStaticJson(res, 400, Buffer.from('{"message":"Bad Request"}\n', 'utf8'), reqId);
      });
  });

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}
