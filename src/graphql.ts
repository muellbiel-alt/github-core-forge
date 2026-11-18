import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  VIEWER,
  type IssueRecord,
  type PullRequestRecord,
  type RepoRecord,
} from './store.ts';
import { sendRestJson } from './rest.ts';

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

type AstValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: AstValue[] }
  | { kind: 'object'; fields: Record<string, AstValue> };

interface Selection {
  kind: 'field' | 'inlineFragment' | 'fragmentSpread';
  alias?: string;
  name?: string;
  args?: Record<string, AstValue>;
  typeCondition?: string;
  selections?: Selection[];
}

interface OperationDef {
  opType: 'query' | 'mutation';
  name?: string;
  varDefaults: Record<string, AstValue>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface ParsedDocument {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

class GqlParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 44) {
        this.pos += 1;
      } else if (ch === 35) {
        while (this.pos < this.src.length && this.src.charCodeAt(this.pos) !== 10) this.pos += 1;
      } else {
        break;
      }
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) {
      throw new GqlParseError(`Expected '${ch}' at ${this.pos}, got '${this.src[this.pos] ?? 'EOF'}'`);
    }
    this.pos += 1;
  }

  private readName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos]!)) {
      this.pos += 1;
    }
    if (this.pos === start) throw new GqlParseError(`Expected name at ${this.pos}`);
    return this.src.slice(start, this.pos);
  }

  private readString(): string {
    this.pos += 1; // opening "
    if (this.src.slice(this.pos, this.pos + 2) === '""') {
      this.pos += 2;
      const end = this.src.indexOf('"""', this.pos);
      if (end < 0) throw new GqlParseError('Unterminated block string');
      const val = this.src.slice(this.pos, end);
      this.pos = end + 3;
      return val;
    }
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++]!;
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.src[this.pos++]!;
        if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u') {
          const hex = this.src.slice(this.pos, this.pos + 4);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
        } else {
          out += esc;
        }
      } else {
        out += ch;
      }
    }
    throw new GqlParseError('Unterminated string');
  }

  private readNumber(): AstValue {
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos]!)) this.pos += 1;
    let isFloat = false;
    if (this.src[this.pos] === '.') {
      isFloat = true;
      this.pos += 1;
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos]!)) this.pos += 1;
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      isFloat = true;
      this.pos += 1;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1;
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos]!)) this.pos += 1;
    }
    const raw = this.src.slice(start, this.pos);
    return isFloat ? { kind: 'float', value: Number.parseFloat(raw) } : { kind: 'int', value: Number.parseInt(raw, 10) };
  }

  private readValue(): AstValue {
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'var', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.readNumber();
    if (ch === '[') {
      this.pos += 1;
      const values: AstValue[] = [];
      while (this.peek() !== ']') values.push(this.readValue());
      this.pos += 1;
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Record<string, AstValue> = {};
      while (this.peek() !== '}') {
        const key = this.readName();
        this.expect(':');
        fields[key] = this.readValue();
      }
      this.pos += 1;
      return { kind: 'object', fields };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'bool', value: true };
    if (name === 'false') return { kind: 'bool', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private readArguments(): Record<string, AstValue> {
    const args: Record<string, AstValue> = {};
    if (this.peek() !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
    this.pos += 1;
    return args;
  }

  private skipTypeRef(): void {
    if (this.peek() === '[') {
      this.pos += 1;
      this.skipTypeRef();
      this.expect(']');
    } else {
      this.readName();
    }
    if (this.peek() === '!') this.pos += 1;
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      this.readArguments();
    }
  }

  private readSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        if (this.peek() === 'o' && this.src.slice(this.pos, this.pos + 2) === 'on' && /\s/.test(this.src[this.pos + 2] ?? '')) {
          this.pos += 2;
          const typeCondition = this.readName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.readSelectionSet() });
        } else if (this.peek() === '{') {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', selections: this.readSelectionSet() });
        } else {
          const fragName = this.readName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name: fragName });
        }
        continue;
      }
      const first = this.readName();
      let alias: string | undefined;
      let name = first;
      if (this.peek() === ':') {
        this.pos += 1;
        alias = first;
        name = this.readName();
      }
      const args = this.readArguments();
      this.skipDirectives();
      const sub = this.peek() === '{' ? this.readSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    this.pos += 1;
    return selections;
  }

  parse(): ParsedDocument {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== '') {
      if (this.peek() === '{') {
        operations.push({ opType: 'query', varDefaults: {}, selections: this.readSelectionSet() });
        continue;
      }
      const kw = this.readName();
      if (kw === 'fragment') {
        const name = this.readName();
        const onKw = this.readName();
        if (onKw !== 'on') throw new GqlParseError('Expected on in fragment definition');
        const typeCondition = this.readName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.readSelectionSet() });
        continue;
      }
      if (kw === 'query' || kw === 'mutation' || kw === 'subscription') {
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') {
          name = this.readName();
        }
        const varDefaults: Record<string, AstValue> = {};
        if (this.peek() === '(') {
          this.pos += 1;
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.readName();
            this.expect(':');
            this.skipTypeRef();
            if (this.peek() === '=') {
              this.pos += 1;
              varDefaults[varName] = this.readValue();
            }
          }
          this.pos += 1;
        }
        this.skipDirectives();
        operations.push({
          opType: kw === 'mutation' ? 'mutation' : 'query',
          name,
          varDefaults,
          selections: this.readSelectionSet(),
        });
        continue;
      }
      throw new GqlParseError(`Unexpected keyword ${kw}`);
    }
    return { operations, fragments };
  }
}

function evalAstValue(ast: AstValue | undefined, vars: Record<string, unknown>, defaults: Record<string, AstValue>): unknown {
  if (!ast) return undefined;
  switch (ast.kind) {
    case 'var':
      if (ast.name in vars) return vars[ast.name];
      if (ast.name in defaults) return evalAstValue(defaults[ast.name], vars, defaults);
      return undefined;
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return ast.value;
    case 'null':
      return null;
    case 'list':
      return ast.values.map((v) => evalAstValue(v, vars, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ast.fields)) {
        out[k] = evalAstValue(v, vars, defaults);
      }
      return out;
    }
  }
}

interface SchemaTypeInfo {
  readonly kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'INPUT_OBJECT' | 'SCALAR';
  readonly name: string;
  readonly fields?: readonly string[];
  readonly enumValues?: readonly string[];
}

const SCHEMA_TYPES: Readonly<Record<string, SchemaTypeInfo>> = {
  Query: {
    kind: 'OBJECT',
    name: 'Query',
    fields: ['viewer', 'repository', 'node', '__type', '__schema'],
  },
  Mutation: {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  User: {
    kind: 'OBJECT',
    name: 'User',
    fields: ['id', 'login', 'name', 'email'],
  },
  Repository: {
    kind: 'OBJECT',
    name: 'Repository',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequests',
      'pullRequest',
    ],
  },
  Ref: {
    kind: 'OBJECT',
    name: 'Ref',
    fields: ['name'],
  },
  Issue: {
    kind: 'OBJECT',
    name: 'Issue',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  },
  IssueConnection: {
    kind: 'OBJECT',
    name: 'IssueConnection',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  },
  IssueEdge: {
    kind: 'OBJECT',
    name: 'IssueEdge',
    fields: ['cursor', 'node'],
  },
  PullRequest: {
    kind: 'OBJECT',
    name: 'PullRequest',
    fields: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    fields: ['nodes', 'pageInfo', 'totalCount'],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileConnection',
    fields: ['nodes'],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: ['path', 'additions', 'deletions'],
  },
  IssueComment: {
    kind: 'OBJECT',
    name: 'IssueComment',
    fields: ['id', 'body'],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    name: 'IssueCommentEdge',
    fields: ['node'],
  },
  PageInfo: {
    kind: 'OBJECT',
    name: 'PageInfo',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  },
  Node: {
    kind: 'INTERFACE',
    name: 'Node',
    fields: ['id'],
  },
  SearchType: {
    kind: 'ENUM',
    name: 'SearchType',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
  IssueState: {
    kind: 'ENUM',
    name: 'IssueState',
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    kind: 'ENUM',
    name: 'PullRequestState',
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeableState: {
    kind: 'ENUM',
    name: 'MergeableState',
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  PullRequestMergeMethod: {
    kind: 'ENUM',
    name: 'PullRequestMergeMethod',
    enumValues: ['MERGE', 'SQUASH', 'REBASE'],
  },
  RepositoryPermission: {
    kind: 'ENUM',
    name: 'RepositoryPermission',
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
  IssueOrderField: {
    kind: 'ENUM',
    name: 'IssueOrderField',
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  },
  OrderDirection: {
    kind: 'ENUM',
    name: 'OrderDirection',
    enumValues: ['ASC', 'DESC'],
  },
  CreateIssuePayload: { kind: 'OBJECT', name: 'CreateIssuePayload', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', name: 'CloseIssuePayload', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', name: 'MergePullRequestPayload', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', name: 'AddCommentPayload', fields: ['commentEdge'] },
};

function expandSelections(
  selections: readonly Selection[],
  typeName: string,
  fragments: ReadonlyMap<string, FragmentDef>,
): Selection[] {
  const out: Selection[] = [];
  for (const sel of selections) {
    if (sel.kind === 'field') {
      out.push(sel);
    } else if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === typeName || typeName === 'Node') {
        out.push(...expandSelections(sel.selections ?? [], typeName, fragments));
      }
    } else if (sel.kind === 'fragmentSpread' && sel.name) {
      const frag = fragments.get(sel.name);
      if (frag && (frag.typeCondition === typeName || typeName === 'Node')) {
        out.push(...expandSelections(frag.selections, typeName, fragments));
      }
    }
  }
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const n = Number.parseInt(raw.slice(7), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

interface ExecCtx {
  readonly store: ForgeStore;
  readonly vars: Record<string, unknown>;
  readonly defaults: Record<string, AstValue>;
  readonly fragments: ReadonlyMap<string, FragmentDef>;
  readonly errors: GqlError[];
}

function argVal(ctx: ExecCtx, sel: Selection, name: string): unknown {
  return evalAstValue(sel.args?.[name], ctx.vars, ctx.defaults);
}

function resolveSelectionObject(
  ctx: ExecCtx,
  typeName: string,
  selections: readonly Selection[] | undefined,
  path: Array<string | number>,
  resolver: (fieldName: string, sel: Selection, fieldPath: Array<string | number>) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = SCHEMA_TYPES[typeName]?.fields;
  const expanded = expandSelections(selections ?? [], typeName, ctx.fragments);
  for (const sel of expanded) {
    if (sel.kind !== 'field' || !sel.name) continue;
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (allowed && !allowed.includes(sel.name)) {
      ctx.errors.push({
        message: `Field '${sel.name}' doesn't exist on type '${typeName}'`,
        path: fieldPath,
      });
      continue;
    }
    out[key] = resolver(sel.name, sel, fieldPath);
  }
  return out;
}

function resolveTypeInfo(ctx: ExecCtx, info: SchemaTypeInfo, selections: readonly Selection[] | undefined, path: Array<string | number>): Record<string, unknown> {
  return resolveSelectionObject(ctx, '__Type', selections, path, (field, sel) => {
    if (field === 'name') return info.name;
    if (field === 'kind') return info.kind;
    if (field === 'fields') {
      if (!info.fields) return null;
      return info.fields.map((f) =>
        resolveSelectionObject(ctx, '__Field', sel.selections, [...path, 'fields'], (sub) => (sub === 'name' ? f : null)),
      );
    }
    if (field === 'enumValues') {
      if (!info.enumValues) return null;
      return info.enumValues.map((v) =>
        resolveSelectionObject(ctx, '__EnumValue', sel.selections, [...path, 'enumValues'], (sub) => (sub === 'name' ? v : null)),
      );
    }
    return null;
  });
}

function resolveIssue(ctx: ExecCtx, issue: IssueRecord, selections: readonly Selection[] | undefined, path: Array<string | number>): Record<string, unknown> {
  return resolveSelectionObject(ctx, 'Issue', selections, path, (field) => {
    switch (field) {
      case 'id':
        return issue.node_id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'createdAt':
        return issue.created_at;
      case 'updatedAt':
        return issue.updated_at;
      default:
        return null;
    }
  });
}

function resolvePullRequest(
  ctx: ExecCtx,
  repo: RepoRecord,
  pr: PullRequestRecord,
  selections: readonly Selection[] | undefined,
  path: Array<string | number>,
): Record<string, unknown> {
  return resolveSelectionObject(ctx, 'PullRequest', selections, path, (field, sel, fieldPath) => {
    switch (field) {
      case 'id':
        return pr.node_id;
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'merged':
        return pr.merged;
      case 'state':
        return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'mergeable':
        return pr.merged ? 'UNKNOWN' : ctx.store.isPullMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
      case 'files': {
        const first = typeof argVal(ctx, sel, 'first') === 'number' ? (argVal(ctx, sel, 'first') as number) : 30;
        const files = ctx.store.getPullFiles(repo, pr).slice(0, Math.max(0, first));
        return resolveSelectionObject(ctx, 'PullRequestChangedFileConnection', sel.selections, fieldPath, (connField, connSel, connPath) => {
          if (connField === 'nodes') {
            return files.map((f, idx) =>
              resolveSelectionObject(ctx, 'PullRequestChangedFile', connSel.selections, [...connPath, idx], (ff) => {
                if (ff === 'path') return f.filename;
                if (ff === 'additions') return f.additions;
                if (ff === 'deletions') return f.deletions;
                return null;
              }),
            );
          }
          return null;
        });
      }
      default:
        return null;
    }
  });
}

function resolveRepository(
  ctx: ExecCtx,
  repo: RepoRecord,
  selections: readonly Selection[] | undefined,
  path: Array<string | number>,
): Record<string, unknown> {
  return resolveSelectionObject(ctx, 'Repository', selections, path, (field, sel, fieldPath) => {
    switch (field) {
      case 'id':
        return repo.node_id;
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return resolveSelectionObject(ctx, 'User', sel.selections, fieldPath, (uf) => {
          if (uf === 'id') return VIEWER.nodeId;
          if (uf === 'login') return VIEWER.login;
          if (uf === 'name') return VIEWER.name;
          if (uf === 'email') return VIEWER.email;
          return null;
        });
      case 'defaultBranchRef': {
        const refExists = repo.refs.has(`refs/heads/${repo.defaultBranch}`);
        if (!refExists) return null;
        return resolveSelectionObject(ctx, 'Ref', sel.selections, fieldPath, (rf) => (rf === 'name' ? repo.defaultBranch : null));
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const num = argVal(ctx, sel, 'number');
        const issue = typeof num === 'number' ? repo.issues.get(num) : undefined;
        return issue ? resolveIssue(ctx, issue, sel.selections, fieldPath) : null;
      }
      case 'issues': {
        const statesRaw = argVal(ctx, sel, 'states');
        const states = Array.isArray(statesRaw) ? statesRaw.map((s) => String(s).toLowerCase()) : null;
        const orderByRaw = argVal(ctx, sel, 'orderBy') as Record<string, unknown> | undefined;
        const direction = typeof orderByRaw?.direction === 'string' ? orderByRaw.direction.toUpperCase() : 'ASC';
        let filtered = states ? repo.issueList.filter((i) => states.includes(i.state)) : [...repo.issueList];
        filtered.sort((a, b) => {
          let cmp = a.createdSeq - b.createdSeq;
          if (cmp === 0) cmp = a.number - b.number;
          return direction === 'DESC' ? -cmp : cmp;
        });
        const afterIdx = decodeCursor(argVal(ctx, sel, 'after'));
        const startIdx = afterIdx !== null ? afterIdx + 1 : 0;
        const firstRaw = argVal(ctx, sel, 'first');
        const first = typeof firstRaw === 'number' && firstRaw >= 0 ? firstRaw : filtered.length;
        const sliced = filtered.slice(startIdx, startIdx + first);
        const hasNextPage = startIdx + sliced.length < filtered.length;
        const hasPreviousPage = startIdx > 0;
        const startCursor = sliced.length > 0 ? encodeCursor(startIdx) : null;
        const endCursor = sliced.length > 0 ? encodeCursor(startIdx + sliced.length - 1) : null;

        return resolveSelectionObject(ctx, 'IssueConnection', sel.selections, fieldPath, (connField, connSel, connPath) => {
          if (connField === 'totalCount') return filtered.length;
          if (connField === 'nodes') {
            return sliced.map((issue, idx) => resolveIssue(ctx, issue, connSel.selections, [...connPath, idx]));
          }
          if (connField === 'edges') {
            return sliced.map((issue, idx) =>
              resolveSelectionObject(ctx, 'IssueEdge', connSel.selections, [...connPath, idx], (ef, esel, epath) => {
                if (ef === 'cursor') return encodeCursor(startIdx + idx);
                if (ef === 'node') return resolveIssue(ctx, issue, esel.selections, epath);
                return null;
              }),
            );
          }
          if (connField === 'pageInfo') {
            return resolveSelectionObject(ctx, 'PageInfo', connSel.selections, connPath, (pf) => {
              if (pf === 'hasNextPage') return hasNextPage;
              if (pf === 'hasPreviousPage') return hasPreviousPage;
              if (pf === 'startCursor') return startCursor;
              if (pf === 'endCursor') return endCursor;
              return null;
            });
          }
          return null;
        });
      }
      case 'pullRequest': {
        const num = argVal(ctx, sel, 'number');
        const pr = typeof num === 'number' ? repo.pulls.get(num) : undefined;
        return pr ? resolvePullRequest(ctx, repo, pr, sel.selections, fieldPath) : null;
      }
      case 'pullRequests': {
        const statesRaw = argVal(ctx, sel, 'states');
        const states = Array.isArray(statesRaw) ? statesRaw.map((s) => String(s).toUpperCase()) : null;
        const filtered = states
          ? repo.pullList.filter((pr) => {
              const s = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
              return states.includes(s);
            })
          : repo.pullList;
        const firstRaw = argVal(ctx, sel, 'first');
        const first = typeof firstRaw === 'number' && firstRaw >= 0 ? firstRaw : filtered.length;
        const sliced = filtered.slice(0, first);
        return resolveSelectionObject(ctx, 'PullRequestConnection', sel.selections, fieldPath, (connField, connSel, connPath) => {
          if (connField === 'totalCount') return filtered.length;
          if (connField === 'nodes') {
            return sliced.map((pr, idx) => resolvePullRequest(ctx, repo, pr, connSel.selections, [...connPath, idx]));
          }
          if (connField === 'pageInfo') {
            return resolveSelectionObject(ctx, 'PageInfo', connSel.selections, connPath, (pf) => {
              if (pf === 'hasNextPage') return sliced.length < filtered.length;
              if (pf === 'hasPreviousPage') return false;
              return null;
            });
          }
          return null;
        });
      }
      default:
        return null;
    }
  });
}

function executeOperation(
  store: ForgeStore,
  op: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const queryText = typeof op.query === 'string' ? op.query : '';
  if (!queryText.trim()) {
    return { data: null, errors: [{ message: 'Missing GraphQL query string' }] };
  }
  let doc: ParsedDocument;
  try {
    doc = new Parser(queryText).parse();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const opName = typeof op.operationName === 'string' ? op.operationName : undefined;
  const def = opName ? doc.operations.find((o) => o.name === opName) ?? doc.operations[0] : doc.operations[0];
  if (!def) {
    return { data: null, errors: [{ message: 'No operation found' }] };
  }

  const vars = typeof op.variables === 'object' && op.variables !== null && !Array.isArray(op.variables)
    ? (op.variables as Record<string, unknown>)
    : {};
  const ctx: ExecCtx = {
    store,
    vars,
    defaults: def.varDefaults,
    fragments: doc.fragments,
    errors: [],
  };

  if (def.opType === 'query') {
    const data = resolveSelectionObject(ctx, 'Query', def.selections, [], (field, sel, fieldPath) => {
      if (field === 'viewer') {
        return resolveSelectionObject(ctx, 'User', sel.selections, fieldPath, (uf) => {
          if (uf === 'id') return VIEWER.nodeId;
          if (uf === 'login') return VIEWER.login;
          if (uf === 'name') return VIEWER.name;
          if (uf === 'email') return VIEWER.email;
          return null;
        });
      }
      if (field === 'repository') {
        const owner = String(argVal(ctx, sel, 'owner') ?? '');
        const name = String(argVal(ctx, sel, 'name') ?? '');
        const repo = store.getRepo(owner, name);
        return repo ? resolveRepository(ctx, repo, sel.selections, fieldPath) : null;
      }
      if (field === 'node') {
        const id = String(argVal(ctx, sel, 'id') ?? '');
        const ref = store.getNode(id);
        if (!ref) return null;
        if (ref.kind === 'Repository') return resolveRepository(ctx, ref.repo, sel.selections, fieldPath);
        if (ref.kind === 'Issue') return resolveIssue(ctx, ref.issue, sel.selections, fieldPath);
        if (ref.kind === 'PullRequest') return resolvePullRequest(ctx, ref.repo, ref.pull, sel.selections, fieldPath);
        if (ref.kind === 'User') {
          return resolveSelectionObject(ctx, 'User', sel.selections, fieldPath, (uf) => (uf === 'id' ? VIEWER.nodeId : uf === 'login' ? VIEWER.login : null));
        }
        return null;
      }
      if (field === '__type') {
        const name = String(argVal(ctx, sel, 'name') ?? '');
        const info = SCHEMA_TYPES[name];
        return info ? resolveTypeInfo(ctx, info, sel.selections, fieldPath) : null;
      }
      if (field === '__schema') {
        return resolveSelectionObject(ctx, '__Schema', sel.selections, fieldPath, (sf, ssel, spath) => {
          if (sf === 'types') {
            return Object.values(SCHEMA_TYPES).map((t, idx) => resolveTypeInfo(ctx, t, ssel.selections, [...spath, idx]));
          }
          if (sf === 'queryType') return resolveTypeInfo(ctx, SCHEMA_TYPES.Query!, ssel.selections, spath);
          if (sf === 'mutationType') return resolveTypeInfo(ctx, SCHEMA_TYPES.Mutation!, ssel.selections, spath);
          return null;
        });
      }
      return null;
    });
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }

  // Mutation
  const data = resolveSelectionObject(ctx, 'Mutation', def.selections, [], (field, sel, fieldPath) => {
    const input = (argVal(ctx, sel, 'input') ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const ref = store.getNode(repoId);
      if (!ref || ref.kind !== 'Repository') {
        ctx.errors.push({ message: 'Repository not found', path: fieldPath });
        return null;
      }
      const created = store.createIssue(ref.repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if (!created.ok) {
        ctx.errors.push({ message: created.error, path: fieldPath });
        return null;
      }
      return resolveSelectionObject(ctx, 'CreateIssuePayload', sel.selections, fieldPath, (pf, psel, ppath) =>
        pf === 'issue' ? resolveIssue(ctx, created.issue, psel.selections, ppath) : null,
      );
    }
    if (field === 'closeIssue') {
      const issueId = String(input.issueId ?? '');
      const ref = store.getNode(issueId);
      if (!ref || ref.kind !== 'Issue') {
        ctx.errors.push({ message: 'Issue not found', path: fieldPath });
        return null;
      }
      store.updateIssue(ref.repo, ref.issue, { state: 'closed' });
      return resolveSelectionObject(ctx, 'CloseIssuePayload', sel.selections, fieldPath, (pf, psel, ppath) =>
        pf === 'issue' ? resolveIssue(ctx, ref.issue, psel.selections, ppath) : null,
      );
    }
    if (field === 'createPullRequest') {
      const repoId = String(input.repositoryId ?? '');
      const ref = store.getNode(repoId);
      if (!ref || ref.kind !== 'Repository') {
        ctx.errors.push({ message: 'Repository not found', path: fieldPath });
        return null;
      }
      const created = store.createPull(ref.repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (!created.ok) {
        ctx.errors.push({ message: created.error, path: fieldPath });
        return null;
      }
      return resolveSelectionObject(ctx, 'CreatePullRequestPayload', sel.selections, fieldPath, (pf, psel, ppath) =>
        pf === 'pullRequest' ? resolvePullRequest(ctx, ref.repo, created.pull, psel.selections, ppath) : null,
      );
    }
    if (field === 'mergePullRequest') {
      const prId = String(input.pullRequestId ?? '');
      const ref = store.getNode(prId);
      if (!ref || ref.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'Pull request not found', path: fieldPath });
        return null;
      }
      const methodRaw = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const mergeMethod = methodRaw === 'merge' || methodRaw === 'rebase' ? methodRaw : 'squash';
      const merged = store.mergePull(ref.repo, ref.pull, mergeMethod);
      if (merged.status !== 200) {
        ctx.errors.push({ message: merged.error, path: fieldPath });
        return null;
      }
      return resolveSelectionObject(ctx, 'MergePullRequestPayload', sel.selections, fieldPath, (pf, psel, ppath) =>
        pf === 'pullRequest' ? resolvePullRequest(ctx, ref.repo, ref.pull, psel.selections, ppath) : null,
      );
    }
    if (field === 'addComment') {
      const subjectId = String(input.subjectId ?? '');
      const ref = store.getNode(subjectId);
      if (!ref || ref.kind !== 'Issue') {
        ctx.errors.push({ message: 'Subject not found', path: fieldPath });
        return null;
      }
      const comment = store.addComment(ref.repo, ref.issue, String(input.body ?? ''));
      return resolveSelectionObject(ctx, 'AddCommentPayload', sel.selections, fieldPath, (pf, psel, ppath) => {
        if (pf === 'commentEdge') {
          return resolveSelectionObject(ctx, 'IssueCommentEdge', psel.selections, ppath, (ef, esel, epath) => {
            if (ef === 'node') {
              return resolveSelectionObject(ctx, 'IssueComment', esel.selections, epath, (cf) =>
                cf === 'id' ? comment.node_id : cf === 'body' ? comment.body : null,
              );
            }
            return null;
          });
        }
        return null;
      });
    }
    return null;
  });
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphqlRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  reqId: string,
): void {
  if ((req.method ?? 'POST') !== 'POST') {
    sendRestJson(res, 405, { message: 'Method Not Allowed' }, reqId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendRestJson(res, 400, { message: 'Problems parsing JSON' }, reqId);
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((op) =>
      typeof op === 'object' && op !== null
        ? executeOperation(store, op as { query?: unknown; variables?: unknown; operationName?: unknown })
        : { data: null, errors: [{ message: 'Invalid operation object' }] },
    );
    sendRestJson(res, 200, results, reqId);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendRestJson(res, 400, { message: 'Problems parsing JSON' }, reqId);
    return;
  }
  const result = executeOperation(store, parsed as { query?: unknown; variables?: unknown; operationName?: unknown });
  sendRestJson(res, 200, result, reqId);
}
