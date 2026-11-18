import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  HEX40,
  VIEWER,
  parseCommit,
  parseTree,
  type RepoRecord,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const NOT_FOUND_BUF = Buffer.from('{"message":"Not Found"}\n', 'utf8');
const BAD_JSON_BUF = Buffer.from('{"message":"Problems parsing JSON"}\n', 'utf8');

function sendJsonBuf(
  res: ServerResponse,
  status: number,
  buf: Buffer,
  reqId: string,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': reqId,
    ...extraHeaders,
  });
  res.end(buf);
}

export function sendRestJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  reqId: string,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  sendJsonBuf(res, status, buf, reqId, extraHeaders);
}

function sendRestError(res: ServerResponse, status: number, message: string, reqId: string): void {
  sendRestJson(res, status, { message }, reqId);
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function parseIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

function buildLinkHeader(req: IncomingMessage, pathname: string, page: number, perPage: number, totalPages: number, extraQuery = ''): string | undefined {
  if (page >= totalPages) return undefined;
  const host = req.headers.host ?? '127.0.0.1';
  const suffix = extraQuery ? `&${extraQuery}` : '';
  return `<http://${host}${pathname}?per_page=${perPage}&page=${page + 1}${suffix}>; rel="next", <http://${host}${pathname}?per_page=${perPage}&page=${totalPages}${suffix}>; rel="last"`;
}

function decodePathSegments(rawSegments: readonly string[]): string {
  return rawSegments.map((s) => decodeURIComponent(s)).join('/');
}

function parseCommitTimestamp(authorLine: string): string {
  const match = /\s(\d+)\s[+-]\d{4}$/.exec(authorLine);
  if (!match) return '2025-01-01T00:00:00.000Z';
  const sec = Number.parseInt(match[1]!, 10);
  return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : '2025-01-01T00:00:00.000Z';
}

function parseCommitIdentity(authorLine: string): { name: string; email: string; date: string } {
  const date = parseCommitTimestamp(authorLine);
  const match = /^(.*?)\s*<([^>]*)>/.exec(authorLine);
  return {
    name: match?.[1]?.trim() || VIEWER.name,
    email: match?.[2]?.trim() || VIEWER.email,
    date,
  };
}

function listCommitsFromTip(repo: RepoRecord, tipOid: string, limit: number): Array<Record<string, unknown>> {
  const visited = new Set<string>();
  const queue: string[] = [tipOid];
  const commits: Array<Record<string, unknown>> = [];
  while (queue.length > 0 && commits.length < limit) {
    const oid = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    commits.push({
      sha: oid,
      commit: {
        message: parsed.message.replace(/\n$/, ''),
        author: parseCommitIdentity(parsed.author),
        committer: parseCommitIdentity(parsed.committer),
        tree: { sha: parsed.tree },
      },
      parents: parsed.parents.map((p) => ({ sha: p })),
    });
    for (const parent of parsed.parents) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return commits;
}

export function handleRestRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
  reqId: string,
): void {
  const method = req.method ?? 'GET';
  const sub = pathname === '/api/v3' || pathname === '/api/v3/' ? '/' : pathname.slice('/api/v3'.length);

  if (method === 'GET' && sub === '/') {
    sendRestJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      reqId,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (method === 'GET' && sub === '/meta') {
    sendRestJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, reqId);
    return;
  }

  if (method === 'GET' && sub === '/user') {
    sendRestJson(
      res,
      200,
      {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: VIEWER.nodeId,
        name: VIEWER.name,
        email: VIEWER.email,
        type: VIEWER.type,
      },
      reqId,
    );
    return;
  }

  if (sub === '/user/repos') {
    if (method === 'GET') {
      const perPage = parseIntParam(query.get('per_page'), 30, 1, 100);
      const page = parseIntParam(query.get('page'), 1, 1, 100_000);
      const all = store.listViewerRepos();
      const { slice, totalPages } = paginate(all, page, perPage);
      const link = buildLinkHeader(req, '/api/v3/user/repos', page, perPage, totalPages);
      sendRestJson(
        res,
        200,
        slice.map((r) => store.repoToJson(r)),
        reqId,
        link ? { link } : undefined,
      );
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
        return;
      }
      const data = parsed.value;
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name) {
        sendRestError(res, 422, 'Validation Failed: name is required', reqId);
        return;
      }
      const repo = store.createRepo({
        name,
        description: typeof data.description === 'string' ? data.description : '',
        private: Boolean(data.private),
        defaultBranch: typeof data.default_branch === 'string' && data.default_branch ? data.default_branch : 'main',
      });
      if (!repo) {
        sendRestError(res, 422, 'Repository creation failed: name already exists on this account', reqId);
        return;
      }
      if (data.auto_init === true) {
        store.putContentFile(repo, {
          path: 'README.md',
          content: Buffer.from(`# ${name}\n`, 'utf8'),
          message: 'Initial commit',
        });
      }
      sendRestJson(res, 201, store.repoToJson(repo), reqId);
      return;
    }
  }

  const parts = sub.split('/').filter(Boolean);

  if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'repos' && method === 'GET') {
    const owner = decodeURIComponent(parts[1]!);
    if (owner.toLowerCase() !== VIEWER.login) {
      sendRestJson(res, 200, [], reqId);
      return;
    }
    const perPage = parseIntParam(query.get('per_page'), 30, 1, 100);
    const page = parseIntParam(query.get('page'), 1, 1, 100_000);
    const all = store.listViewerRepos();
    const { slice, totalPages } = paginate(all, page, perPage);
    const link = buildLinkHeader(req, `/api/v3/users/${owner}/repos`, page, perPage, totalPages);
    sendRestJson(res, 200, slice.map((r) => store.repoToJson(r)), reqId, link ? { link } : undefined);
    return;
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = decodeURIComponent(parts[1]!);
    const repoName = decodeURIComponent(parts[2]!);
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
      return;
    }

    // Fast path for GET /api/v3/repos/{owner}/{repo}/issues/{number}
    if (method === 'GET' && parts.length === 5 && parts[3] === 'issues') {
      const issueNum = Number.parseInt(parts[4]!, 10);
      if (Number.isInteger(issueNum) && issueNum > 0) {
        const issue = repo.issues.get(issueNum);
        if (!issue) {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        sendJsonBuf(res, 200, issue.serializedJson, reqId);
        return;
      }
    }

    // /repos/{owner}/{repo}
    if (parts.length === 3) {
      if (method === 'GET') {
        sendRestJson(res, 200, store.repoToJson(repo), reqId);
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
          return;
        }
        const d = parsed.value;
        store.updateRepo(repo, {
          name: typeof d.name === 'string' ? d.name : undefined,
          description: typeof d.description === 'string' ? d.description : undefined,
          private: typeof d.private === 'boolean' ? d.private : undefined,
          default_branch: typeof d.default_branch === 'string' ? d.default_branch : undefined,
        });
        sendRestJson(res, 200, store.repoToJson(repo), reqId);
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': reqId });
        res.end();
        return;
      }
    }

    // /repos/{owner}/{repo}/branches[/{branch}]
    if (parts[3] === 'branches' && method === 'GET') {
      const branches: Array<{ name: string; commit: { sha: string }; protected: boolean }> = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
        }
      }
      if (parts.length === 4) {
        sendRestJson(res, 200, branches, reqId);
        return;
      }
      const wanted = decodePathSegments(parts.slice(4));
      const found = branches.find((b) => b.name === wanted);
      if (!found) {
        sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
        return;
      }
      sendRestJson(res, 200, found, reqId);
      return;
    }

    // /repos/{owner}/{repo}/git/refs...
    if (parts[3] === 'git' && (parts[4] === 'refs' || parts[4] === 'ref')) {
      if (parts.length === 5 && method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
          return;
        }
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/') || !HEX40.test(sha)) {
          sendRestError(res, 422, 'Validation Failed: ref and sha required', reqId);
          return;
        }
        if (repo.refs.has(ref)) {
          sendRestError(res, 422, 'Reference already exists', reqId);
          return;
        }
        repo.refs.set(ref, sha);
        store.invalidateRepoGitCache(repo);
        sendRestJson(res, 201, { ref, object: { type: 'commit', sha } }, reqId);
        return;
      }
      if (method === 'GET') {
        if (parts.length === 5) {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { type: 'commit', sha } }));
          sendRestJson(res, 200, all, reqId);
          return;
        }
        const refSuffix = decodePathSegments(parts.slice(5));
        const fullRef = refSuffix.startsWith('refs/') ? refSuffix : `refs/${refSuffix}`;
        const sha = repo.refs.get(fullRef);
        if (!sha) {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        sendRestJson(res, 200, { ref: fullRef, object: { type: 'commit', sha } }, reqId);
        return;
      }
    }

    // /repos/{owner}/{repo}/commits
    if (parts.length === 4 && parts[3] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha') ?? undefined;
      const tip = store.resolveRef(repo, shaParam);
      if (!tip) {
        if (shaParam === undefined) {
          sendRestJson(res, 200, [], reqId);
          return;
        }
        sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
        return;
      }
      const perPage = parseIntParam(query.get('per_page'), 30, 1, 100);
      const page = parseIntParam(query.get('page'), 1, 1, 100_000);
      const allCommits = listCommitsFromTip(repo, tip, page * perPage);
      const { slice } = paginate(allCommits, page, perPage);
      sendRestJson(res, 200, slice, reqId);
      return;
    }

    // /repos/{owner}/{repo}/contents/{path...}
    if (parts[3] === 'contents') {
      const filePath = decodePathSegments(parts.slice(4)).replace(/^\/+|\/+$/g, '');
      if (method === 'GET') {
        const refParam = query.get('ref') ?? undefined;
        const commitSha = store.resolveRef(repo, refParam);
        if (!commitSha) {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        const commitObj = repo.objects.get(commitSha);
        if (!commitObj || commitObj.type !== 'commit') {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        const rootTree = parseCommit(commitObj.data).tree;
        const target = store.readTreeEntry(repo, rootTree, filePath);
        if (!target) {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        if (target.kind === 'file') {
          const blob = repo.objects.get(target.oid);
          if (!blob) {
            sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
            return;
          }
          const name = filePath.split('/').pop() ?? filePath;
          sendRestJson(
            res,
            200,
            {
              type: 'file',
              encoding: 'base64',
              size: blob.data.length,
              name,
              path: filePath,
              content: blob.data.toString('base64'),
              sha: target.oid,
            },
            reqId,
          );
          return;
        }
        const dirObj = repo.objects.get(target.oid);
        if (!dirObj || dirObj.type !== 'tree') {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        const entries = parseTree(dirObj.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: filePath ? `${filePath}/${entry.name}` : entry.name,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        }));
        sendRestJson(res, 200, entries, reqId);
        return;
      }

      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
          return;
        }
        const d = parsed.value;
        const message = typeof d.message === 'string' ? d.message : '';
        const contentB64 = typeof d.content === 'string' ? d.content : '';
        if (!message || typeof d.content !== 'string') {
          sendRestError(res, 422, 'Validation Failed: message and content are required', reqId);
          return;
        }
        const contentBuf = Buffer.from(contentB64, 'base64');
        const result = store.putContentFile(repo, {
          path: filePath,
          content: contentBuf,
          message,
          branch: typeof d.branch === 'string' ? d.branch : undefined,
          sha: typeof d.sha === 'string' ? d.sha : undefined,
        });
        if (result.status === 409) {
          sendRestError(res, 409, result.error ?? 'Conflict', reqId);
          return;
        }
        const name = filePath.split('/').pop() ?? filePath;
        sendRestJson(
          res,
          result.status,
          {
            content: {
              name,
              path: filePath,
              sha: result.contentSha,
              size: result.size,
              type: 'file',
              encoding: 'base64',
            },
            commit: {
              sha: result.commitSha,
              message,
            },
          },
          reqId,
        );
        return;
      }

      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
          return;
        }
        const d = parsed.value;
        const message = typeof d.message === 'string' ? d.message : 'Delete file';
        const sha = typeof d.sha === 'string' ? d.sha : '';
        const result = store.deleteContentFile(repo, {
          path: filePath,
          message,
          sha,
          branch: typeof d.branch === 'string' ? d.branch : undefined,
        });
        if (result.status !== 200) {
          sendRestError(res, result.status, result.error ?? 'Error', reqId);
          return;
        }
        sendRestJson(res, 200, { content: null, commit: { sha: result.commitSha, message } }, reqId);
        return;
      }
    }

    // /repos/{owner}/{repo}/labels
    if (parts.length === 4 && parts[3] === 'labels') {
      if (method === 'GET') {
        sendRestJson(res, 200, [...repo.labels.values()], reqId);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
          return;
        }
        const name = typeof parsed.value.name === 'string' ? parsed.value.name.trim() : '';
        if (!name) {
          sendRestError(res, 422, 'Validation Failed: name is required', reqId);
          return;
        }
        const label = store.createLabel(repo, {
          name,
          color: typeof parsed.value.color === 'string' ? parsed.value.color : undefined,
          description: typeof parsed.value.description === 'string' ? parsed.value.description : undefined,
        });
        sendRestJson(res, 201, label, reqId);
        return;
      }
    }

    // /repos/{owner}/{repo}/issues...
    if (parts[3] === 'issues') {
      if (parts.length === 4) {
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
            return;
          }
          const d = parsed.value;
          const title = typeof d.title === 'string' ? d.title : '';
          if (!title) {
            sendRestError(res, 422, 'Validation Failed: title is required', reqId);
            return;
          }
          const labels = Array.isArray(d.labels) ? d.labels.filter((l): l is string => typeof l === 'string') : undefined;
          const result = store.createIssue(repo, {
            title,
            body: typeof d.body === 'string' ? d.body : '',
            labels,
          });
          if (!result.ok) {
            sendRestError(res, 422, result.error, reqId);
            return;
          }
          sendJsonBuf(res, 201, result.issue.serializedJson, reqId);
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const perPage = parseIntParam(query.get('per_page'), 30, 1, 100);
          const page = parseIntParam(query.get('page'), 1, 1, 100_000);
          let list = state === 'all' ? [...repo.issueList] : repo.issueList.filter((i) => i.state === state);
          list.sort((a, b) => {
            let cmp = 0;
            if (sort === 'comments') cmp = a.comments.length - b.comments.length;
            else cmp = a.createdSeq - b.createdSeq;
            if (cmp === 0) cmp = a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
          const { slice, totalPages } = paginate(list, page, perPage);
          const link = buildLinkHeader(req, `/api/v3/repos/${owner}/${repoName}/issues`, page, perPage, totalPages, `state=${encodeURIComponent(state)}`);
          // Build JSON array directly from pre-serialized issue buffers!
          const jsonText = `[${slice.map((i) => i.serializedJson.subarray(0, i.serializedJson.length - 1).toString('utf8')).join(',')}]\n`;
          sendJsonBuf(res, 200, Buffer.from(jsonText, 'utf8'), reqId, link ? { link } : undefined);
          return;
        }
      }

      if (parts.length >= 5) {
        const issueNum = Number.parseInt(parts[4]!, 10);
        const issue = Number.isInteger(issueNum) ? repo.issues.get(issueNum) : undefined;
        if (!issue) {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        if (parts.length === 5 && method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
            return;
          }
          const d = parsed.value;
          const nextState = d.state === 'open' || d.state === 'closed' ? d.state : undefined;
          const nextLabels = Array.isArray(d.labels) ? d.labels.filter((l): l is string => typeof l === 'string') : undefined;
          const updated = store.updateIssue(repo, issue, {
            title: typeof d.title === 'string' ? d.title : undefined,
            body: typeof d.body === 'string' ? d.body : undefined,
            state: nextState,
            labels: nextLabels,
          });
          if (!updated.ok) {
            sendRestError(res, 422, updated.error, reqId);
            return;
          }
          sendJsonBuf(res, 200, updated.issue.serializedJson, reqId);
          return;
        }
        if (parts.length === 6 && parts[5] === 'comments') {
          if (method === 'GET') {
            sendRestJson(res, 200, issue.comments, reqId);
            return;
          }
          if (method === 'POST') {
            const parsed = parseJsonBody(body);
            if (!parsed.ok) {
              sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
              return;
            }
            const commentBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
            if (!commentBody) {
              sendRestError(res, 422, 'Validation Failed: body is required', reqId);
              return;
            }
            const comment = store.addComment(repo, issue, commentBody);
            sendRestJson(res, 201, comment, reqId);
            return;
          }
        }
      }
    }

    // /repos/{owner}/{repo}/pulls...
    if (parts[3] === 'pulls') {
      if (parts.length === 4) {
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
            return;
          }
          const d = parsed.value;
          const title = typeof d.title === 'string' ? d.title : '';
          const head = typeof d.head === 'string' ? d.head : '';
          const base = typeof d.base === 'string' ? d.base : '';
          if (!title || !head || !base) {
            sendRestError(res, 422, 'Validation Failed: title, head and base are required', reqId);
            return;
          }
          const created = store.createPull(repo, {
            title,
            body: typeof d.body === 'string' ? d.body : '',
            head,
            base,
          });
          if (!created.ok) {
            sendRestError(res, 422, created.error, reqId);
            return;
          }
          sendRestJson(res, 201, store.pullToJson(repo, created.pull), reqId);
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = parseIntParam(query.get('per_page'), 30, 1, 100);
          const page = parseIntParam(query.get('page'), 1, 1, 100_000);
          const filtered = state === 'all' ? repo.pullList : repo.pullList.filter((p) => p.state === state);
          const { slice } = paginate(filtered, page, perPage);
          sendRestJson(res, 200, slice.map((p) => store.pullToJson(repo, p)), reqId);
          return;
        }
      }

      if (parts.length >= 5) {
        const pullNum = Number.parseInt(parts[4]!, 10);
        const pr = Number.isInteger(pullNum) ? repo.pulls.get(pullNum) : undefined;
        if (!pr) {
          sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
          return;
        }
        if (parts.length === 5 && method === 'GET') {
          sendRestJson(res, 200, store.pullToJson(repo, pr), reqId);
          return;
        }
        if (parts.length === 6 && parts[5] === 'files' && method === 'GET') {
          sendRestJson(res, 200, store.getPullFiles(repo, pr), reqId);
          return;
        }
        if (parts.length === 6 && parts[5] === 'merge' && method === 'PUT') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJsonBuf(res, 400, BAD_JSON_BUF, reqId);
            return;
          }
          const m = parsed.value.merge_method;
          const mergeMethod = m === 'merge' || m === 'rebase' || m === 'squash' ? m : 'squash';
          const result = store.mergePull(repo, pr, mergeMethod);
          if (result.status !== 200) {
            sendRestError(res, result.status, result.error, reqId);
            return;
          }
          sendRestJson(res, 200, { sha: result.sha, merged: true, message: result.message }, reqId);
          return;
        }
      }
    }
  }

  sendJsonBuf(res, 404, NOT_FOUND_BUF, reqId);
}
