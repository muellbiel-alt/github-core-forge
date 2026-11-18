import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, VIEWER } from './store.ts';
import { sendRestJson } from './rest.ts';

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: readonly string[];
  };
}

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of an existing repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body text' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request between branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body text' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOLS_LIST_PAYLOAD = Object.freeze({ tools: MCP_TOOLS });

const SERVER_INFO = Object.freeze({ name: 'github-core-forge', version: '1.0.0' });

function rpcResult(res: ServerResponse, id: unknown, result: unknown, reqId: string, extraHeaders?: Readonly<Record<string, string>>): void {
  sendRestJson(res, 200, { jsonrpc: '2.0', id, result }, reqId, extraHeaders);
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, reqId: string): void {
  sendRestJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }, reqId);
}

function toolOk(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

function toolErr(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  return typeof val === 'string' ? val.trim() : '';
}

function intArg(args: Record<string, unknown>, key: string): number | null {
  const val = args[key];
  if (typeof val === 'number' && Number.isInteger(val)) return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) return Number.parseInt(val, 10);
  return null;
}

function executeTool(
  store: ForgeStore,
  name: string,
  args: Record<string, unknown>,
): { kind: 'ok'; result: Record<string, unknown> } | { kind: 'rpc-error'; code: number; message: string } {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (!repoName) return { kind: 'rpc-error', code: -32602, message: 'Missing required argument: name' };
      const repo = store.createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        private: Boolean(args.private),
      });
      if (!repo) return { kind: 'ok', result: toolErr(`Repository ${VIEWER.login}/${repoName} already exists`) };
      return { kind: 'ok', result: toolOk(store.repoToJson(repo)) };
    }

    case 'get_repo': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      if (!owner || !repoName) return { kind: 'rpc-error', code: -32602, message: 'Missing required arguments: owner, repo' };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { kind: 'ok', result: toolErr(`Repository ${owner}/${repoName} not found`) };
      return { kind: 'ok', result: toolOk(store.repoToJson(repo)) };
    }

    case 'create_issue': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const title = strArg(args, 'title');
      if (!owner || !repoName || !title) {
        return { kind: 'rpc-error', code: -32602, message: 'Missing required arguments: owner, repo, title' };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { kind: 'ok', result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const created = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if (!created.ok) return { kind: 'ok', result: toolErr(created.error) };
      const parsed: unknown = JSON.parse(created.issue.serializedJson.toString('utf8'));
      return { kind: 'ok', result: toolOk(parsed) };
    }

    case 'list_issues': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      if (!owner || !repoName) return { kind: 'rpc-error', code: -32602, message: 'Missing required arguments: owner, repo' };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { kind: 'ok', result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const state = strArg(args, 'state') || 'open';
      const list = (state === 'all' ? repo.issueList : repo.issueList.filter((i) => i.state === state)).map((i) =>
        JSON.parse(i.serializedJson.toString('utf8')) as unknown,
      );
      return { kind: 'ok', result: toolOk(list) };
    }

    case 'create_pull_request': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (!owner || !repoName || !title || !head || !base) {
        return { kind: 'rpc-error', code: -32602, message: 'Missing required arguments: owner, repo, title, head, base' };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { kind: 'ok', result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const created = store.createPull(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      if (!created.ok) return { kind: 'ok', result: toolErr(created.error) };
      return { kind: 'ok', result: toolOk(store.pullToJson(repo, created.pull)) };
    }

    case 'merge_pull_request': {
      const owner = strArg(args, 'owner');
      const repoName = strArg(args, 'repo');
      const pullNumber = intArg(args, 'pull_number');
      if (!owner || !repoName || pullNumber === null) {
        return { kind: 'rpc-error', code: -32602, message: 'Missing required arguments: owner, repo, pull_number' };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { kind: 'ok', result: toolErr(`Repository ${owner}/${repoName} not found`) };
      const pr = repo.pulls.get(pullNumber);
      if (!pr) return { kind: 'ok', result: toolErr(`Pull request #${pullNumber} not found`) };
      const rawMethod = strArg(args, 'merge_method').toLowerCase();
      const mergeMethod = rawMethod === 'merge' || rawMethod === 'rebase' ? rawMethod : 'squash';
      const merged = store.mergePull(repo, pr, mergeMethod);
      if (merged.status !== 200) return { kind: 'ok', result: toolErr(merged.error) };
      return { kind: 'ok', result: toolOk({ sha: merged.sha, merged: true, message: merged.message }) };
    }

    default:
      return { kind: 'rpc-error', code: -32601, message: `Unknown tool: ${name}` };
  }
}

export function handleMcpRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  reqId: string,
): void {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': reqId });
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendRestJson(res, 405, { message: 'Method Not Allowed' }, reqId);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error', reqId);
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rpcError(res, 400, null, -32600, 'Invalid Request', reqId);
    return;
  }

  const msg = parsed as Record<string, unknown>;
  const rpcMethod = typeof msg.method === 'string' ? msg.method : '';
  const hasId = 'id' in msg && msg.id !== undefined;
  const id = hasId ? msg.id : null;
  const params = typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params)
    ? (msg.params as Record<string, unknown>)
    : {};

  if (!hasId || rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': reqId });
    res.end();
    return;
  }

  if (rpcMethod === 'server/discover') {
    rpcResult(
      res,
      id,
      {
        resultType: 'discover',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
        },
      },
      reqId,
    );
    return;
  }

  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' && params.protocolVersion ? params.protocolVersion : '2025-11-25';
    rpcResult(
      res,
      id,
      {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
      reqId,
      { 'mcp-session-id': 'session-1' },
    );
    return;
  }

  if (rpcMethod === 'ping') {
    rpcResult(res, id, {}, reqId);
    return;
  }

  if (rpcMethod === 'tools/list') {
    rpcResult(res, id, TOOLS_LIST_PAYLOAD, reqId);
    return;
  }

  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const outcome = executeTool(store, toolName, args);
    if (outcome.kind === 'rpc-error') {
      rpcError(res, 200, id, outcome.code, outcome.message, reqId);
      return;
    }
    rpcResult(res, id, outcome.result, reqId);
    return;
  }

  rpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`, reqId);
}
