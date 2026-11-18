import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, Agent as HttpAgent, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync } from 'node:zlib';
import { handleGitRequest } from './src/git.ts';
import { handleGraphqlRequest } from './src/graphql.ts';
import { handleMcpRequest } from './src/mcp.ts';
import { handleRestRequest } from './src/rest.ts';
import { ForgeStore } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const HEALTHZ_BUF = Buffer.from('{"ok":true}\n', 'utf8');
const UNAUTH_BUF = Buffer.from('{"message":"Requires authentication"}\n', 'utf8');
const NOT_FOUND_BUF = Buffer.from('{"message":"Not Found"}\n', 'utf8');
const BAD_REQ_BUF = Buffer.from('{"message":"Bad Request"}\n', 'utf8');
const EMPTY_BUF = Buffer.alloc(0);
const EMPTY_QUERY = new URLSearchParams();
const GIT_ROUTE_RE = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/;

function isAuthorized(req: IncomingMessage, expectedToken: string, expectedBearer: string): boolean {
  if (expectedToken === '') return true;
  const auth = req.headers.authorization;
  if (auth === expectedBearer) return true;
  if (typeof auth !== 'string') return false;
  const space = auth.indexOf(' ');
  if (space <= 0) return false;
  if (auth.slice(0, space).toLowerCase() !== 'bearer') return false;
  return auth.slice(space + 1) === expectedToken;
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
  const expectedBearer = expectedToken === '' ? '' : `Bearer ${expectedToken}`;

  const dispatch = (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
    body: Buffer,
    reqId: string,
  ): void => {
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
    if (!isAuthorized(req, expectedToken, expectedBearer)) {
      sendStaticJson(res, 401, UNAUTH_BUF, reqId);
      return;
    }

    if (method === 'GET') {
      const cachedIssue = store.issueRouteCache.get(pathname);
      if (cachedIssue !== undefined) {
        res.writeHead(200, {
          'content-type': JSON_TYPE,
          'content-length': cachedIssue.length,
          'x-github-request-id': reqId,
        });
        res.end(cachedIssue);
        return;
      }
      const query = qIdx < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIdx + 1));
      dispatch(req, res, pathname, query, EMPTY_BUF, reqId);
      return;
    }

    if (method === 'HEAD') {
      const query = qIdx < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIdx + 1));
      dispatch(req, res, pathname, query, EMPTY_BUF, reqId);
      return;
    }

    const query = qIdx < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIdx + 1));
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = chunks.length === 0 ? EMPTY_BUF : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      if (method === 'POST') {
        const fastRepo = store.issuesPostCache.get(pathname);
        if (fastRepo !== undefined) {
          let parsed: unknown;
          try {
            parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
          } catch {
            sendStaticJson(res, 400, Buffer.from('{"message":"Problems parsing JSON"}\n', 'utf8'), reqId);
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            sendStaticJson(res, 400, Buffer.from('{"message":"Problems parsing JSON"}\n', 'utf8'), reqId);
            return;
          }
          const d = parsed as Record<string, unknown>;
          const title = typeof d.title === 'string' ? d.title : '';
          if (!title) {
            sendStaticJson(res, 422, Buffer.from('{"message":"Validation Failed: title is required"}\n', 'utf8'), reqId);
            return;
          }
          const labels = Array.isArray(d.labels) ? d.labels.filter((l): l is string => typeof l === 'string') : undefined;
          const created = store.createIssue(fastRepo, {
            title,
            body: typeof d.body === 'string' ? d.body : '',
            labels,
          });
          if (!created.ok) {
            sendStaticJson(res, 422, Buffer.from(`${JSON.stringify({ message: created.error })}\n`, 'utf8'), reqId);
            return;
          }
          res.writeHead(201, {
            'content-type': JSON_TYPE,
            'content-length': created.issue.serializedJson.length,
            'x-github-request-id': reqId,
          });
          res.end(created.issue.serializedJson);
          return;
        }
      }
      dispatch(req, res, pathname, query, body, reqId);
    });
    req.on('error', () => {
      if (!res.headersSent) sendStaticJson(res, 400, BAD_REQ_BUF, reqId);
    });
  });

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}

/** Run a short throwaway loopback warmup so V8 JIT-compiles hot server paths before registration. */
export async function warmUpServer(): Promise<void> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authHeader = token === '' ? '' : `Bearer ${token}`;
  const warmServer = createApp();
  await new Promise<void>((resolve) => warmServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = warmServer.address();
  if (addr === null || typeof addr === 'string') {
    warmServer.close();
    return;
  }
  const port = addr.port;
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 16 });
  const hit = (method: string, path: string, body?: Buffer, extra?: Readonly<Record<string, string>>): Promise<void> =>
    new Promise((resolve) => {
      const headers: Record<string, string | number> = { ...extra };
      if (authHeader !== '') headers.authorization = authHeader;
      if (body !== undefined) {
        headers['content-type'] = headers['content-type'] ?? 'application/json';
        headers['content-length'] = body.length;
      }
      const req = httpRequest({ host: '127.0.0.1', port, method, path, agent, headers }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', () => resolve());
      if (body !== undefined) req.end(body);
      else req.end();
    });

  try {
    await hit('POST', '/api/v3/user/repos', Buffer.from('{"name":"w"}'));
    const issueBody = Buffer.from('{"title":"w","body":"b"}');
    for (let i = 0; i < 4; i += 1) {
      await Promise.all(Array.from({ length: 25 }, () => hit('POST', '/api/v3/repos/adaiversen/w/issues', issueBody)));
    }
    for (let i = 0; i < 100; i += 1) {
      await Promise.all(Array.from({ length: 16 }, () => hit('GET', '/api/v3/repos/adaiversen/w/issues/1')));
    }
    await hit('PUT', '/api/v3/repos/adaiversen/w/contents/a.txt', Buffer.from('{"message":"m","content":"aGVsbG8="}'));
    const warmBlob = Buffer.from('warm\n');
    const warmBlobSha = createHash('sha1').update(`blob ${warmBlob.length}\0`).update(warmBlob).digest('hex');
    const packHdr = Buffer.alloc(12);
    packHdr.write('PACK', 0, 4, 'ascii');
    packHdr.writeUInt32BE(2, 4);
    packHdr.writeUInt32BE(1, 8);
    const objHdr = Buffer.from([(3 << 4) | warmBlob.length]);
    const packBody = Buffer.concat([packHdr, objHdr, deflateSync(warmBlob)]);
    const warmPack = Buffer.concat([packBody, createHash('sha1').update(packBody).digest()]);
    const zero40 = '0'.repeat(40);
    const cmdLine = `${zero40} ${warmBlobSha} refs/heads/warm\u0000report-status-v2 side-band-64k\n`;
    const cmdPkt = Buffer.from((cmdLine.length + 4).toString(16).padStart(4, '0') + cmdLine, 'ascii');
    const recBody = Buffer.concat([cmdPkt, Buffer.from('0000', 'ascii'), warmPack]);
    for (let i = 0; i < 20; i += 1) {
      await hit('GET', '/adaiversen/w.git/info/refs?service=git-receive-pack');
      await hit('POST', '/adaiversen/w.git/git-receive-pack', recBody, { 'content-type': 'application/x-git-receive-pack-request' });
    }
    const lsRefsBody = Buffer.from('0014command=ls-refs\n00010009peel\n000csymrefs\n0000');
    const fetchBody = Buffer.from('0012command=fetch\n0001000bno-progress\n000ddeepen 1\n0009done\n0000');
    await Promise.all(
      Array.from({ length: 20 }, () =>
        hit('GET', '/adaiversen/w.git/info/refs?service=git-upload-pack', undefined, { 'git-protocol': 'version=2' }).then(() =>
          hit('POST', '/adaiversen/w.git/git-upload-pack', lsRefsBody, { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' }),
        ).then(() =>
          hit('POST', '/adaiversen/w.git/git-upload-pack', fetchBody, { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' }),
        ),
      ),
    );
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => warmServer.close(() => resolve()));
  }
}
