import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const HEX40 = /^[0-9a-f]{40}$/;

export const VIEWER = Object.freeze({
  id: 1000,
  nodeId: Buffer.from('04:User1000', 'utf8').toString('base64'),
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

const VIEWER_SUMMARY = Object.freeze({
  login: VIEWER.login,
  id: VIEWER.id,
  type: VIEWER.type,
});

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  packEntry?: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export interface LabelRecord {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly node_id: string;
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user: { readonly login: string; readonly id: number; readonly type: string };
}

export interface IssueRecord {
  readonly id: number;
  readonly node_id: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRecord[];
  readonly comments: CommentRecord[];
  readonly createdSeq: number;
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
  serializedJson: Buffer;
}

export interface PullRequestRecord {
  readonly id: number;
  readonly node_id: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  baseSha: string;
  readonly createdSeq: number;
  readonly created_at: string;
  updated_at: string;
}

export interface PullFileDiff {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
}

export interface RepoRecord {
  readonly id: number;
  readonly node_id: string;
  readonly owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  readonly created_at: string;
  updated_at: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly issueList: IssueRecord[];
  readonly pulls: Map<number, PullRequestRecord>;
  readonly pullList: PullRequestRecord[];
  nextIssueNumber: number;
  readonly packCache: Map<string, Buffer>;
  readonly lsRefsCache: Map<string, Buffer>;
  readonly rawV2Cache: Map<string, Buffer>;
  receiveAdvCache: Buffer | null;
  readonly commitAncestryCache: Map<string, Set<string>>;
}

export type NodeRef =
  | { readonly kind: 'Repository'; readonly repo: RepoRecord }
  | { readonly kind: 'Issue'; readonly repo: RepoRecord; readonly issue: IssueRecord }
  | { readonly kind: 'PullRequest'; readonly repo: RepoRecord; readonly pull: PullRequestRecord }
  | { readonly kind: 'IssueComment'; readonly repo: RepoRecord; readonly comment: CommentRecord }
  | { readonly kind: 'User' };

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashGitObject(type: GitObjectType, data: Buffer): string {
  // Pass the header as a string: update() accepts it directly, so no Buffer allocation.
  return createHash('sha1').update(`${type} ${data.length}\u0000`, 'utf8').update(data).digest('hex');
}

export function encodePackObjectEntry(obj: GitObject): Buffer {
  if (obj.packEntry !== undefined) return obj.packEntry;
  const code = TYPE_CODE[obj.type];
  let remaining = obj.data.length;
  const bytes: number[] = [];
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  const packed = Buffer.concat([Buffer.from(bytes), deflateSync(obj.data)]);
  obj.packEntry = packed;
  return packed;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('Malformed tree: missing space');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('Malformed tree: truncated entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): ParsedCommit {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const val = line.slice(space + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestampSec: number;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestampSec} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestampSec} +0000`);
  lines.push('');
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

export function parseTag(data: Buffer): ParsedTag {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') as GitObjectType) ?? 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

function encodeNodeId(kind: string, id: number): string {
  return Buffer.from(`04:${kind}${id}`, 'utf8').toString('base64');
}

export class ForgeStore {
  readonly baseEpochSec: number;
  private seq = 0;
  private nextIdSeq = 5000;
  private reqSeq = 0;
  private readonly reposByKey = new Map<string, RepoRecord>();
  private readonly repoList: RepoRecord[] = [];
  private readonly nodes = new Map<string, NodeRef>();
  readonly issueRouteCache = new Map<string, Buffer>();
  readonly issuesPostCache = new Map<string, RepoRecord>();

  constructor(trialNowIso?: string) {
    let parsed = 1_735_689_600_000;
    if (trialNowIso) {
      const ms = Date.parse(trialNowIso);
      if (Number.isFinite(ms)) parsed = ms;
    }
    this.baseEpochSec = Math.floor(parsed / 1000);
    this.nodes.set(VIEWER.nodeId, { kind: 'User' });
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `r${this.reqSeq}`;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private nextGlobalId(): number {
    this.nextIdSeq += 1;
    return this.nextIdSeq;
  }

  private timestampFor(seq: number): { epochSec: number; iso: string } {
    const epochSec = this.baseEpochSec + seq;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }

  private repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getNode(id: string): NodeRef | undefined {
    return this.nodes.get(id);
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    if (owner.toLowerCase() !== VIEWER.login) return undefined;
    return this.reposByKey.get(this.repoKey(owner, name));
  }

  listViewerRepos(): readonly RepoRecord[] {
    return this.repoList;
  }

  createRepo(input: { name: string; description?: string; private?: boolean; defaultBranch?: string }): RepoRecord | null {
    const key = this.repoKey(VIEWER.login, input.name);
    if (this.reposByKey.has(key)) return null;
    const id = this.nextGlobalId();
    const seq = this.nextSeq();
    const { iso } = this.timestampFor(seq);
    const repo: RepoRecord = {
      id,
      node_id: encodeNodeId('Repository', id),
      owner: VIEWER.login,
      name: input.name,
      description: input.description ?? '',
      private: Boolean(input.private),
      defaultBranch: input.defaultBranch || 'main',
      created_at: iso,
      updated_at: iso,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueList: [],
      pulls: new Map(),
      pullList: [],
      nextIssueNumber: 1,
      packCache: new Map(),
      lsRefsCache: new Map(),
      rawV2Cache: new Map(),
      receiveAdvCache: null,
      commitAncestryCache: new Map(),
    };
    this.reposByKey.set(key, repo);
    this.repoList.push(repo);
    this.nodes.set(repo.node_id, { kind: 'Repository', repo });
    this.issuesPostCache.set(`/api/v3/repos/${repo.owner}/${repo.name}/issues`, repo);
    return repo;
  }

  updateRepo(repo: RepoRecord, patch: { description?: string; private?: boolean; default_branch?: string; name?: string }): RepoRecord {
    if (patch.name !== undefined && patch.name !== repo.name) {
      this.issuesPostCache.delete(`/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      for (const issue of repo.issueList) {
        this.issueRouteCache.delete(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`);
      }
      this.reposByKey.delete(this.repoKey(repo.owner, repo.name));
      repo.name = patch.name;
      this.reposByKey.set(this.repoKey(repo.owner, repo.name), repo);
      this.issuesPostCache.set(`/api/v3/repos/${repo.owner}/${repo.name}/issues`, repo);
      for (const issue of repo.issueList) {
        this.issueRouteCache.set(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`, issue.serializedJson);
      }
    }
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.private !== undefined) repo.private = patch.private;
    if (patch.default_branch !== undefined) repo.defaultBranch = patch.default_branch;
    repo.updated_at = this.timestampFor(this.nextSeq()).iso;
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.reposByKey.delete(this.repoKey(owner, name));
    this.issuesPostCache.delete(`/api/v3/repos/${repo.owner}/${repo.name}/issues`);
    const idx = this.repoList.indexOf(repo);
    if (idx >= 0) this.repoList.splice(idx, 1);
    this.nodes.delete(repo.node_id);
    for (const issue of repo.issueList) {
      this.issueRouteCache.delete(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`);
      this.nodes.delete(issue.node_id);
      for (const c of issue.comments) this.nodes.delete(c.node_id);
    }
    for (const pr of repo.pullList) this.nodes.delete(pr.node_id);
    return true;
  }

  putObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
    const oid = hashGitObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
    }
    return oid;
  }

  invalidateRepoGitCache(repo: RepoRecord): void {
    if (repo.packCache.size > 0) repo.packCache.clear();
    if (repo.lsRefsCache.size > 0) repo.lsRefsCache.clear();
    if (repo.rawV2Cache.size > 0) repo.rawV2Cache.clear();
    repo.receiveAdvCache = null;
  }

  resolveRef(repo: RepoRecord, refOrSha: string | undefined): string | null {
    const target = refOrSha || repo.defaultBranch;
    if (HEX40.test(target) && repo.objects.has(target)) return target;
    const headRef = target.startsWith('refs/') ? repo.refs.get(target) : repo.refs.get(`refs/heads/${target}`) ?? repo.refs.get(`refs/tags/${target}`);
    if (!headRef) return null;
    const obj = repo.objects.get(headRef);
    if (obj?.type === 'tag') return parseTag(obj.data).object;
    return headRef;
  }

  peelOid(repo: RepoRecord, oid: string): string | undefined {
    let cur = oid;
    for (let i = 0; i < 8; i += 1) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur === oid ? undefined : cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }

  isAncestor(repo: RepoRecord, ancestorOid: string, descendantOid: string): boolean {
    if (ancestorOid === descendantOid) return true;
    const firstObj = repo.objects.get(descendantOid);
    if (firstObj && firstObj.type === 'commit' && firstObj.data.length >= 94) {
      // Fast path for single-parent commit: "tree <40>\nparent <40>\n"
      if (firstObj.data[45] === 0x0a && firstObj.data.subarray(46, 53).toString('ascii') === 'parent ') {
        if (firstObj.data.subarray(53, 93).toString('ascii') === ancestorOid) return true;
      }
    }
    const visited = new Set<string>();
    const stack = [descendantOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        if (parent === ancestorOid) return true;
        if (!visited.has(parent)) stack.push(parent);
      }
    }
    return false;
  }

  collectAncestors(repo: RepoRecord, tipOid: string): Set<string> {
    const visited = new Set<string>();
    const queue = [tipOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
    return visited;
  }

  findMergeBase(repo: RepoRecord, commitA: string, commitB: string): string | null {
    const ancA = this.collectAncestors(repo, commitA);
    const visited = new Set<string>();
    const queue: string[] = [commitB];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (ancA.has(oid)) return oid;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
    return null;
  }

  flattenTree(repo: RepoRecord, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, fullPath, out);
      } else if (entry.mode !== '160000') {
        out.set(fullPath, entry.oid);
      }
    }
    return out;
  }

  buildTreeFromFiles(repo: RepoRecord, files: ReadonlyMap<string, string>): string {
    interface DirNode {
      files: Map<string, string>;
      dirs: Map<string, DirNode>;
    }
    const makeNode = (): DirNode => ({ files: new Map(), dirs: new Map() });
    const root = makeNode();
    for (const [path, oid] of files) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      let cur = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const seg = parts[i]!;
        let next = cur.dirs.get(seg);
        if (!next) {
          next = makeNode();
          cur.dirs.set(seg, next);
        }
        cur = next;
      }
      cur.files.set(parts[parts.length - 1]!, oid);
    }
    const writeDir = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeDir(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return writeDir(root);
  }

  readTreeEntry(repo: RepoRecord, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string } | null {
    const parts = path.split('/').filter(Boolean);
    let curOid = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(curOid);
      if (!obj || obj.type !== 'tree') return null;
      const entries = parseTree(obj.data);
      const found = entries.find((e) => e.name === parts[i]);
      if (!found) return null;
      if (i === parts.length - 1) {
        return { kind: found.mode === '40000' ? 'dir' : 'file', oid: found.oid };
      }
      if (found.mode !== '40000') return null;
      curOid = found.oid;
    }
    return { kind: 'dir', oid: curOid };
  }

  putContentFile(
    repo: RepoRecord,
    opts: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { status: 200 | 201 | 409; commitSha?: string; contentSha?: string; size?: number; error?: string } {
    const branch = opts.branch || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let parentTip = repo.refs.get(refName) ?? null;
    if (parentTip === null && branch !== repo.defaultBranch) {
      parentTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const files = new Map<string, string>();
    if (parentTip !== null) {
      const commitObj = repo.objects.get(parentTip);
      if (commitObj && commitObj.type === 'commit') {
        this.flattenTree(repo, parseCommit(commitObj.data).tree, '', files);
      }
    }
    const cleanPath = opts.path.replace(/^\/+|\/+$/g, '');
    const existingOid = files.get(cleanPath);
    if (existingOid !== undefined) {
      if (opts.sha !== existingOid) {
        return { status: 409, error: `${cleanPath} does not match ${existingOid}` };
      }
    } else if (opts.sha !== undefined) {
      return { status: 409, error: `${cleanPath} does not exist` };
    }

    const blobOid = this.putObject(repo, 'blob', opts.content);
    files.set(cleanPath, blobOid);
    const treeOid = this.buildTreeFromFiles(repo, files);
    const seq = this.nextSeq();
    const { epochSec } = this.timestampFor(seq);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const commitBytes = buildCommit({
      tree: treeOid,
      parents: parentTip ? [parentTip] : [],
      author: identity,
      committer: identity,
      timestampSec: epochSec,
      message: opts.message,
    });
    const commitSha = this.putObject(repo, 'commit', commitBytes);
    repo.refs.set(refName, commitSha);
    this.invalidateRepoGitCache(repo);
    return {
      status: existingOid !== undefined ? 200 : 201,
      commitSha,
      contentSha: blobOid,
      size: opts.content.length,
    };
  }

  deleteContentFile(
    repo: RepoRecord,
    opts: { path: string; message: string; sha: string; branch?: string },
  ): { status: 200 | 404 | 409; commitSha?: string; error?: string } {
    const branch = opts.branch || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentTip = repo.refs.get(refName) ?? null;
    if (!parentTip) return { status: 404, error: 'Not Found' };
    const commitObj = repo.objects.get(parentTip);
    if (!commitObj || commitObj.type !== 'commit') return { status: 404, error: 'Not Found' };
    const files = this.flattenTree(repo, parseCommit(commitObj.data).tree);
    const cleanPath = opts.path.replace(/^\/+|\/+$/g, '');
    const existingOid = files.get(cleanPath);
    if (!existingOid) return { status: 404, error: 'Not Found' };
    if (existingOid !== opts.sha) return { status: 409, error: `${cleanPath} does not match ${existingOid}` };

    files.delete(cleanPath);
    const treeOid = this.buildTreeFromFiles(repo, files);
    const seq = this.nextSeq();
    const { epochSec } = this.timestampFor(seq);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const commitBytes = buildCommit({
      tree: treeOid,
      parents: [parentTip],
      author: identity,
      committer: identity,
      timestampSec: epochSec,
      message: opts.message,
    });
    const commitSha = this.putObject(repo, 'commit', commitBytes);
    repo.refs.set(refName, commitSha);
    this.invalidateRepoGitCache(repo);
    return { status: 200, commitSha };
  }

  createLabel(repo: RepoRecord, input: { name: string; color?: string; description?: string }): LabelRecord {
    const existing = repo.labels.get(input.name);
    if (existing) return existing;
    const id = this.nextGlobalId();
    const label: LabelRecord = {
      id,
      node_id: encodeNodeId('Label', id),
      name: input.name,
      color: (input.color ?? 'ededed').replace(/^#/, ''),
      description: input.description ?? '',
    };
    repo.labels.set(input.name, label);
    return label;
  }

  serializeIssue(repo: RepoRecord, issue: IssueRecord): Buffer {
    const obj = {
      id: issue.id,
      node_id: issue.node_id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
      comments: issue.comments.length,
      user: VIEWER_SUMMARY,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
    issue.serializedJson = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
    this.issueRouteCache.set(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`, issue.serializedJson);
    return issue.serializedJson;
  }

  createIssue(
    repo: RepoRecord,
    input: { title: string; body?: string; labels?: readonly string[] },
  ): { ok: true; issue: IssueRecord } | { ok: false; error: string } {
    const labelObjs: LabelRecord[] = [];
    if (input.labels) {
      for (const name of input.labels) {
        const lbl = repo.labels.get(name);
        if (!lbl) return { ok: false, error: `Validation Failed: unknown label ${name}` };
        labelObjs.push(lbl);
      }
    }
    const id = this.nextGlobalId();
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const seq = this.nextSeq();
    const { iso } = this.timestampFor(seq);
    const issue: IssueRecord = {
      id,
      node_id: encodeNodeId('Issue', id),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: labelObjs,
      comments: [],
      createdSeq: seq,
      created_at: iso,
      updated_at: iso,
      closed_at: null,
      serializedJson: Buffer.alloc(0),
    };
    this.serializeIssue(repo, issue);
    repo.issues.set(number, issue);
    repo.issueList.push(issue);
    this.nodes.set(issue.node_id, { kind: 'Issue', repo, issue });
    return { ok: true, issue };
  }

  updateIssue(
    repo: RepoRecord,
    issue: IssueRecord,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: readonly string[] },
  ): { ok: true; issue: IssueRecord } | { ok: false; error: string } {
    if (patch.labels !== undefined) {
      const nextLabels: LabelRecord[] = [];
      for (const name of patch.labels) {
        const lbl = repo.labels.get(name);
        if (!lbl) return { ok: false, error: `Validation Failed: unknown label ${name}` };
        nextLabels.push(lbl);
      }
      issue.labels = nextLabels;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    const { iso } = this.timestampFor(this.nextSeq());
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.closed_at = patch.state === 'closed' ? iso : null;
    }
    issue.updated_at = iso;
    this.serializeIssue(repo, issue);
    return { ok: true, issue };
  }

  addComment(repo: RepoRecord, issue: IssueRecord, body: string): CommentRecord {
    const id = this.nextGlobalId();
    const { iso } = this.timestampFor(this.nextSeq());
    const comment: CommentRecord = {
      id,
      node_id: encodeNodeId('IssueComment', id),
      body,
      created_at: iso,
      updated_at: iso,
      user: VIEWER_SUMMARY,
    };
    issue.comments.push(comment);
    issue.updated_at = iso;
    this.serializeIssue(repo, issue);
    this.nodes.set(comment.node_id, { kind: 'IssueComment', repo, comment });
    return comment;
  }

  createPull(
    repo: RepoRecord,
    input: { title: string; body?: string; head: string; base: string },
  ): { ok: true; pull: PullRequestRecord } | { ok: false; error: string } {
    const headBranch = input.head.replace(/^refs\/heads\//, '');
    const baseBranch = input.base.replace(/^refs\/heads\//, '');
    const headSha = repo.refs.get(`refs/heads/${headBranch}`);
    const baseSha = repo.refs.get(`refs/heads/${baseBranch}`);
    if (!headSha || !baseSha) {
      return { ok: false, error: 'Validation Failed: head or base branch not found' };
    }
    const id = this.nextGlobalId();
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const seq = this.nextSeq();
    const { iso } = this.timestampFor(seq);
    const pr: PullRequestRecord = {
      id,
      node_id: encodeNodeId('PullRequest', id),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: headBranch,
      headSha,
      baseRef: baseBranch,
      baseSha,
      createdSeq: seq,
      created_at: iso,
      updated_at: iso,
    };
    repo.pulls.set(number, pr);
    repo.pullList.push(pr);
    this.nodes.set(pr.node_id, { kind: 'PullRequest', repo, pull: pr });
    return { ok: true, pull: pr };
  }

  private computeThreeWayMerge(repo: RepoRecord, pr: PullRequestRecord): {
    conflict: boolean;
    mergedFiles: Map<string, string>;
    currentBaseSha: string;
    currentHeadSha: string;
  } {
    const currentBaseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const currentHeadSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const lcaSha = this.findMergeBase(repo, currentBaseSha, currentHeadSha);
    const treeOf = (commitSha: string | null): Map<string, string> => {
      if (!commitSha) return new Map();
      const obj = repo.objects.get(commitSha);
      if (!obj || obj.type !== 'commit') return new Map();
      return this.flattenTree(repo, parseCommit(obj.data).tree);
    };
    const baseFiles = treeOf(lcaSha);
    const oursFiles = treeOf(currentBaseSha);
    const theirsFiles = treeOf(currentHeadSha);
    const allPaths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    const mergedFiles = new Map<string, string>();
    for (const path of allPaths) {
      const b = baseFiles.get(path);
      const o = oursFiles.get(path);
      const t = theirsFiles.get(path);
      if (o === t) {
        if (o !== undefined) mergedFiles.set(path, o);
      } else if (o === b) {
        if (t !== undefined) mergedFiles.set(path, t);
      } else if (t === b) {
        if (o !== undefined) mergedFiles.set(path, o);
      } else {
        return { conflict: true, mergedFiles, currentBaseSha, currentHeadSha };
      }
    }
    return { conflict: false, mergedFiles, currentBaseSha, currentHeadSha };
  }

  isPullMergeable(repo: RepoRecord, pr: PullRequestRecord): boolean {
    if (pr.state !== 'open' || pr.merged) return false;
    return !this.computeThreeWayMerge(repo, pr).conflict;
  }

  getPullFiles(repo: RepoRecord, pr: PullRequestRecord): PullFileDiff[] {
    const currentBaseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const currentHeadSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const lcaSha = this.findMergeBase(repo, currentBaseSha, currentHeadSha) ?? currentBaseSha;
    const treeOf = (commitSha: string): Map<string, string> => {
      const obj = repo.objects.get(commitSha);
      if (!obj || obj.type !== 'commit') return new Map();
      return this.flattenTree(repo, parseCommit(obj.data).tree);
    };
    const baseFiles = treeOf(lcaSha);
    const headFiles = treeOf(currentHeadSha);
    const lineCount = (oid: string): number => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'blob' || obj.data.length === 0) return 0;
      let lines = 1;
      for (let i = 0; i < obj.data.length - 1; i += 1) {
        if (obj.data[i] === 0x0a) lines += 1;
      }
      return lines;
    };
    const diffs: PullFileDiff[] = [];
    const allPaths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
    for (const filename of allPaths) {
      const b = baseFiles.get(filename);
      const h = headFiles.get(filename);
      if (b === undefined && h !== undefined) {
        const additions = Math.max(1, lineCount(h));
        diffs.push({ filename, status: 'added', additions, deletions: 0, changes: additions, sha: h });
      } else if (b !== undefined && h === undefined) {
        const deletions = Math.max(1, lineCount(b));
        diffs.push({ filename, status: 'removed', additions: 0, deletions, changes: deletions, sha: b });
      } else if (b !== undefined && h !== undefined && b !== h) {
        const additions = Math.max(1, lineCount(h));
        const deletions = Math.max(1, lineCount(b));
        diffs.push({ filename, status: 'modified', additions, deletions, changes: additions + deletions, sha: h });
      }
    }
    return diffs;
  }

  mergePull(
    repo: RepoRecord,
    pr: PullRequestRecord,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash',
  ): { status: 200; sha: string; message: string } | { status: 405; error: string } {
    if (pr.state !== 'open' || pr.merged) {
      return { status: 405, error: 'Pull Request is not mergeable' };
    }
    const merged = this.computeThreeWayMerge(repo, pr);
    if (merged.conflict) {
      return { status: 405, error: 'Pull Request is not mergeable' };
    }
    const treeOid = this.buildTreeFromFiles(repo, merged.mergedFiles);
    const seq = this.nextSeq();
    const { epochSec, iso } = this.timestampFor(seq);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const parents = mergeMethod === 'merge' ? [merged.currentBaseSha, merged.currentHeadSha] : [merged.currentBaseSha];
    const commitBytes = buildCommit({
      tree: treeOid,
      parents,
      author: identity,
      committer: identity,
      timestampSec: epochSec,
      message: `${pr.title} (#${pr.number})`,
    });
    const mergeSha = this.putObject(repo, 'commit', commitBytes);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    this.invalidateRepoGitCache(repo);
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = iso;
    pr.updated_at = iso;
    pr.merge_commit_sha = mergeSha;
    pr.baseSha = merged.currentBaseSha;
    pr.headSha = merged.currentHeadSha;
    return { status: 200, sha: mergeSha, message: 'Pull Request successfully merged' };
  }

  pullToJson(repo: RepoRecord, pr: PullRequestRecord): Record<string, unknown> {
    const headSha = pr.merged ? pr.headSha : (repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha);
    const baseSha = pr.merged ? pr.baseSha : (repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha);
    return {
      id: pr.id,
      node_id: pr.node_id,
      number: pr.number,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      merged: pr.merged,
      merged_at: pr.merged_at,
      merge_commit_sha: pr.merge_commit_sha,
      mergeable: this.isPullMergeable(repo, pr),
      head: {
        ref: pr.headRef,
        sha: headSha,
        label: `${repo.owner}:${pr.headRef}`,
      },
      base: {
        ref: pr.baseRef,
        sha: baseSha,
        label: `${repo.owner}:${pr.baseRef}`,
      },
      user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    };
  }

  repoToJson(repo: RepoRecord): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: repo.node_id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      owner: { login: repo.owner, id: VIEWER.id, node_id: VIEWER.nodeId, type: VIEWER.type },
      created_at: repo.created_at,
      updated_at: repo.updated_at,
    };
  }
}
