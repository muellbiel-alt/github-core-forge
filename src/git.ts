import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inflateSync } from 'node:zlib';
import {
  ForgeStore,
  HEX40,
  ZERO_OID,
  encodePackObjectEntry,
  hashGitObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type RepoRecord,
} from './store.ts';

const PKT_MAX = 65520;
const SIDEBAND_CHUNK_MAX = PKT_MAX - 5; // 4-byte pkt header + 1-byte band
const HEX4 = /^[0-9a-fA-F]{4}$/;
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const FLUSH_BUF = Buffer.from('0000', 'ascii');
const DELIM_BUF = Buffer.from('0001', 'ascii');
const V2_UPLOAD_PACK_ADV = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=makefun-forge/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  FLUSH_BUF,
]);
const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=makefun-forge/1.0';
const MAIN_OK_INNER = Buffer.concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), FLUSH_BUF]);
const MAIN_OK_SIDEBAND = Buffer.concat([pktSideband(1, MAIN_OK_INNER), FLUSH_BUF]);
const EMPTY_PACK = (() => {
  const hdr = Buffer.alloc(12);
  hdr.write('PACK', 0, 4, 'ascii');
  hdr.writeUInt32BE(2, 4);
  hdr.writeUInt32BE(0, 8);
  return Buffer.concat([hdr, createHash('sha1').update(hdr).digest()]);
})();

class PktLineError extends Error {}
class PackError extends Error {}

type PktItem =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

function pktSideband(band: number, data: Buffer): Buffer {
  const header = Buffer.from((data.length + 5).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, Buffer.from([band]), data]);
}

function decodePktLines(buf: Buffer, stopOnFlush = false): { packets: PktItem[]; offset: number } {
  const packets: PktItem[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new PktLineError('Truncated pkt-line length');
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(lenHex)) throw new PktLineError(`Invalid pkt-line length: ${lenHex}`);
    const len = Number.parseInt(lenHex, 16);
    offset += 4;
    if (len === 0) {
      packets.push({ kind: 'flush' });
      if (stopOnFlush) return { packets, offset };
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      continue;
    }
    if (len === 3 || len > PKT_MAX) throw new PktLineError(`Invalid pkt-line length ${len}`);
    const payloadLen = len - 4;
    if (offset + payloadLen > buf.length) throw new PktLineError('Truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(offset, offset + payloadLen) });
    offset += payloadLen;
  }
  return { packets, offset };
}

function readVarintSize(buf: Buffer, start: number): { size: number; first: number; next: number } {
  if (start >= buf.length) throw new PackError('Truncated pack entry header');
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new PackError('Truncated pack entry varint');
    byte = buf[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, first, next: offset };
}

function readOfsDeltaOffset(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new PackError('Truncated ofs-delta offset');
  let byte = buf[start]!;
  let offset = start + 1;
  let val = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new PackError('Truncated ofs-delta offset');
    byte = buf[offset++]!;
    val = (val + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: val, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let val = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new PackError('Truncated delta size');
      const b = delta[offset++]!;
      val += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return val;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) throw new PackError(`Delta base size mismatch: ${srcSize} != ${base.length}`);
  const out = Buffer.allocUnsafe(dstSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOff = 0;
      let copyLen = 0;
      for (let b = 0; b < 4; b += 1) {
        if (op & (1 << b)) copyOff += delta[offset++]! * 2 ** (b * 8);
      }
      for (let b = 0; b < 3; b += 1) {
        if (op & (1 << (b + 4))) copyLen += delta[offset++]! * 2 ** (b * 8);
      }
      if (copyLen === 0) copyLen = 0x10000;
      base.copy(out, written, copyOff, copyOff + copyLen);
      written += copyLen;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, offset, offset + lit);
      offset += lit;
      written += lit;
    } else {
      throw new PackError('Invalid delta opcode 0');
    }
  }
  if (written !== dstSize) throw new PackError('Delta output size mismatch');
  return out;
}

function unpackPack(repo: RepoRecord, pack: Buffer): void {
  if (pack.length < 32) throw new PackError('Pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('Bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`Unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expectedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!expectedTrailer.equals(pack.subarray(trailerStart))) {
    throw new PackError('Pack trailer checksum mismatch');
  }

  interface RawPackEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolvedData?: Buffer;
    oid?: string;
  }

  const raw: RawPackEntry[] = [];
  let byOffset: Map<number, RawPackEntry> | null = null;
  let offset = 12;
  const bodySlice = pack.subarray(0, trailerStart);

  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const hdr = readVarintSize(pack, offset);
    offset = hdr.next;
    const typeCode = (hdr.first >> 4) & 0x07;
    if (typeCode >= 1 && typeCode <= 4 && byOffset === null) {
      const inflated = inflateSync(bodySlice.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      if (inflated.buffer.length !== hdr.size) throw new PackError('Inflated size mismatch');
      offset += inflated.engine.bytesWritten;
      const type = CODE_TYPE[typeCode]!;
      const oid = hashGitObject(type, inflated.buffer);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, { type, data: inflated.buffer });
      }
      raw.push({ offset: entryOffset, typeCode, size: hdr.size, data: inflated.buffer, resolvedType: type, resolvedData: inflated.buffer, oid });
      continue;
    }

    if (byOffset === null) {
      byOffset = new Map<number, RawPackEntry>();
      for (const prev of raw) byOffset.set(prev.offset, prev);
    }

    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: hdr.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const ofs = readOfsDeltaOffset(pack, offset);
      offset = ofs.next;
      entry.baseOffset = entryOffset - ofs.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('Truncated ref-delta oid');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new PackError(`Unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateSync(bodySlice.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== hdr.size) throw new PackError('Inflated size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new PackError('Trailing bytes before pack trailer');

  if (byOffset === null) return;

  const byOid = new Map<string, RawPackEntry>();
  for (const prev of raw) {
    if (prev.oid) byOid.set(prev.oid, prev);
  }
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolvedData && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolvedData, oid: entry.oid };
    }
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset!.get(entry.baseOffset!);
      if (!baseEntry) throw new PackError('Missing ofs-delta base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const existing = repo.objects.get(entry.baseOid!);
        if (!existing) throw new PackError(`Missing ref-delta base ${entry.baseOid}`);
        type = existing.type;
        data = applyDelta(existing.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashGitObject(type, data);
    entry.resolvedType = type;
    entry.resolvedData = data;
    entry.oid = oid;
    byOid.set(oid, entry);
    return { type, data, oid };
  };

  for (const entry of raw) {
    if (entry.oid) continue;
    const resolved = resolve(entry);
    if (!repo.objects.has(resolved.oid)) {
      repo.objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    }
  }
}

function buildPackFromOids(repo: RepoRecord, oids: readonly string[]): Buffer {
  if (oids.length === 0) return EMPTY_PACK;
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    parts.push(encodePackObjectEntry(obj));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function appendPackSideband(packBuf: Buffer, out: Buffer[]): void {
  for (let offset = 0; offset < packBuf.length; offset += SIDEBAND_CHUNK_MAX) {
    const end = Math.min(offset + SIDEBAND_CHUNK_MAX, packBuf.length);
    out.push(pktSideband(1, packBuf.subarray(offset, end)));
  }
}

function collectHaveState(repo: RepoRecord, haves: readonly string[], clientShallows: ReadonlySet<string>): {
  haveCommits: Set<string>;
  haveObjects: Set<string>;
} {
  const haveCommits = new Set<string>();
  const haveObjects = new Set<string>();
  const commitQueue: string[] = [];

  for (const oid of haves) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      commitQueue.push(oid);
    } else {
      haveObjects.add(oid);
    }
  }

  while (commitQueue.length > 0) {
    const cid = commitQueue.pop()!;
    if (haveCommits.has(cid)) continue;
    haveCommits.add(cid);
    haveObjects.add(cid);
    if (clientShallows.has(cid)) continue;
    const obj = repo.objects.get(cid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    for (const parent of parsed.parents) {
      if (!haveCommits.has(parent)) commitQueue.push(parent);
    }
  }

  const objQueue: string[] = [];
  for (const cid of haveCommits) {
    const obj = repo.objects.get(cid);
    if (obj?.type === 'commit') objQueue.push(parseCommit(obj.data).tree);
  }
  while (objQueue.length > 0) {
    const oid = objQueue.pop()!;
    if (haveObjects.has(oid)) continue;
    haveObjects.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        if (!haveObjects.has(entry.oid)) objQueue.push(entry.oid);
      }
    }
  }

  return { haveCommits, haveObjects };
}

function computeFetchObjects(
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  clientShallows: readonly string[],
  depth: number | undefined,
): { sendOids: string[]; newShallow: string[]; unshallow: string[]; ackOids: string[] } {
  const clientShallowSet = new Set(clientShallows);
  const { haveCommits, haveObjects } = collectHaveState(repo, haves, clientShallowSet);
  const ackOids = haves.filter((oid) => repo.objects.has(oid));

  const wantCommits = new Set<string>();
  const extraObjects: string[] = [];
  const newShallow: string[] = [];
  const unshallow: string[] = [];

  if (depth !== undefined && depth > 0) {
    const commitDist = new Map<string, number>();
    const bfs: Array<{ oid: string; dist: number }> = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'tag') {
        extraObjects.push(want);
        let cur = parseTag(obj.data).object;
        while (repo.objects.get(cur)?.type === 'tag') {
          extraObjects.push(cur);
          cur = parseTag(repo.objects.get(cur)!.data).object;
        }
        if (repo.objects.get(cur)?.type === 'commit') bfs.push({ oid: cur, dist: 1 });
        else extraObjects.push(cur);
      } else if (obj.type === 'commit') {
        bfs.push({ oid: want, dist: 1 });
      } else {
        extraObjects.push(want);
      }
    }

    for (let head = 0; head < bfs.length; head += 1) {
      const { oid, dist } = bfs[head]!;
      const prev = commitDist.get(oid);
      if (prev !== undefined && prev <= dist) continue;
      commitDist.set(oid, dist);
      if (dist >= depth) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        bfs.push({ oid: parent, dist: dist + 1 });
      }
    }

    for (const [cid, dist] of commitDist) {
      wantCommits.add(cid);
      if (dist === depth) {
        const obj = repo.objects.get(cid);
        if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
          newShallow.push(cid);
        }
      }
    }
    const newShallowSet = new Set(newShallow);
    for (const s of clientShallows) {
      if (commitDist.has(s) && !newShallowSet.has(s)) {
        unshallow.push(s);
      }
    }
  } else {
    const stack: string[] = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'tag') {
        extraObjects.push(want);
        let cur = parseTag(obj.data).object;
        while (repo.objects.get(cur)?.type === 'tag') {
          extraObjects.push(cur);
          cur = parseTag(repo.objects.get(cur)!.data).object;
        }
        if (repo.objects.get(cur)?.type === 'commit') stack.push(cur);
        else extraObjects.push(cur);
      } else if (obj.type === 'commit') {
        stack.push(want);
      } else {
        extraObjects.push(want);
      }
    }
    while (stack.length > 0) {
      const cid = stack.pop()!;
      if (haveCommits.has(cid) || wantCommits.has(cid)) continue;
      wantCommits.add(cid);
      const obj = repo.objects.get(cid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!haveCommits.has(parent) && !wantCommits.has(parent)) stack.push(parent);
      }
    }
  }

  const sendSet = new Set<string>();
  const treeStack: string[] = [];

  for (const oid of extraObjects) {
    if (!haveObjects.has(oid)) sendSet.add(oid);
  }
  for (const cid of wantCommits) {
    if (haveCommits.has(cid)) continue;
    sendSet.add(cid);
    const obj = repo.objects.get(cid);
    if (obj?.type === 'commit') treeStack.push(parseCommit(obj.data).tree);
  }
  while (treeStack.length > 0) {
    const oid = treeStack.pop()!;
    if (haveObjects.has(oid) || sendSet.has(oid)) continue;
    sendSet.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      if (!haveObjects.has(entry.oid) && !sendSet.has(entry.oid)) treeStack.push(entry.oid);
    }
  }

  return { sendOids: [...sendSet], newShallow, unshallow, ackOids };
}

function handleUploadPackV2(store: ForgeStore, repo: RepoRecord, packets: PktItem[], rawKey: string, res: ServerResponse): void {
  let command = '';
  let inArgs = false;
  const args: string[] = [];

  for (const pkt of packets) {
    if (pkt.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\r?\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }

  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
    }
    const cacheKey = `${peel ? 1 : 0}|${symrefs ? 1 : 0}|${unborn ? 1 : 0}|${prefixes.join('\0')}`;
    const cached = repo.lsRefsCache.get(cacheKey);
    if (cached !== undefined) {
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': cached.length,
      });
      res.end(cached);
      return;
    }
    const matchesPrefix = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const lines: Buffer[] = [];
    const defaultRef = `refs/heads/${repo.defaultBranch}`;
    const headOid = repo.refs.get(defaultRef);
    if (matchesPrefix('HEAD')) {
      if (headOid) {
        lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
      } else if (unborn) {
        lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
      }
    }
    for (const [refName, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!matchesPrefix(refName)) continue;
      let extra = '';
      if (peel) {
        const peeled = store.peelOid(repo, oid);
        if (peeled) extra = ` peeled:${peeled}`;
      }
      lines.push(pktLine(`${oid} ${refName}${extra}\n`));
    }
    lines.push(FLUSH_BUF);
    const out = Buffer.concat(lines);
    if (repo.lsRefsCache.size < 32) repo.lsRefsCache.set(cacheKey, out);
    if (repo.rawV2Cache.size < 64) repo.rawV2Cache.set(rawKey, out);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': out.length,
    });
    res.end(out);
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallows: string[] = [];
    let depth: number | undefined;
    let done = false;
    let thinPack = false;
    let noProgress = false;

    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5));
      else if (arg.startsWith('have ')) haves.push(arg.slice(5));
      else if (arg.startsWith('shallow ')) shallows.push(arg.slice(8));
      else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
      else if (arg === 'done') done = true;
      else if (arg === 'thin-pack') thinPack = true;
      else if (arg === 'no-progress') noProgress = true;
    }

    const cacheKey = `${wants.join(',')}|${haves.join(',')}|${shallows.join(',')}|${depth ?? ''}|${thinPack ? 1 : 0}|${noProgress ? 1 : 0}|${done ? 1 : 0}`;
    const cached = repo.packCache.get(cacheKey);
    if (cached !== undefined) {
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': cached.length,
      });
      res.end(cached);
      return;
    }

    const { sendOids, newShallow, unshallow, ackOids } = computeFetchObjects(repo, wants, haves, shallows, depth);
    const parts: Buffer[] = [];
    if (!done && haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (ackOids.length > 0) {
        for (const ack of ackOids) parts.push(pktLine(`ACK ${ack}\n`));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(FLUSH_BUF);
    } else {
      if (newShallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
        parts.push(DELIM_BUF);
      }
      parts.push(pktLine('packfile\n'));
      const packBuf = buildPackFromOids(repo, sendOids);
      appendPackSideband(packBuf, parts);
      parts.push(FLUSH_BUF);
    }

    const responseBuf = Buffer.concat(parts);
    if (repo.packCache.size >= 64) repo.packCache.clear();
    repo.packCache.set(cacheKey, responseBuf);
    if (repo.rawV2Cache.size < 64) repo.rawV2Cache.set(rawKey, responseBuf);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': responseBuf.length,
    });
    res.end(responseBuf);
    return;
  }

  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
  res.end('{"message":"Unsupported git v2 command"}\n');
}

function handleUploadPackV0(repo: RepoRecord, packets: PktItem[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | undefined;
  let useSideband = false;

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\r?\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const sp = rest.indexOf(' ');
      if (sp >= 0) {
        wants.push(rest.slice(0, sp));
        const caps = rest.slice(sp + 1).split(' ');
        if (caps.includes('side-band-64k') || caps.includes('side-band')) useSideband = true;
      } else {
        wants.push(rest);
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5));
    } else if (line.startsWith('shallow ')) {
      shallows.push(line.slice(8));
    } else if (line.startsWith('deepen ')) {
      depth = Number.parseInt(line.slice(7), 10);
    }
  }

  const { sendOids, newShallow, unshallow } = computeFetchObjects(repo, wants, haves, shallows, depth);
  const parts: Buffer[] = [];
  for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (newShallow.length > 0 || unshallow.length > 0) parts.push(FLUSH_BUF);
  parts.push(pktLine('NAK\n'));
  const packBuf = buildPackFromOids(repo, sendOids);
  if (useSideband) {
    appendPackSideband(packBuf, parts);
    parts.push(FLUSH_BUF);
  } else {
    parts.push(packBuf);
  }
  const out = Buffer.concat(parts);
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': out.length,
  });
  res.end(out);
}

export function handleGitRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  subpath: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    const msg = '{"message":"Not Found"}\n';
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': msg.length });
    res.end(msg);
    return;
  }

  const method = req.method ?? 'GET';

  if (method === 'GET' && subpath === '/info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const proto = String(req.headers['git-protocol'] ?? '');
      if (proto.includes('version=2')) {
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'content-length': V2_UPLOAD_PACK_ADV.length,
        });
        res.end(V2_UPLOAD_PACK_ADV);
        return;
      }

      const defaultRef = `refs/heads/${repo.defaultBranch}`;
      const caps = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed symref=HEAD:${defaultRef} agent=makefun-forge/1.0`;
      const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH_BUF];
      if (repo.refs.size === 0) {
        parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
      } else {
        let first = true;
        const headOid = repo.refs.get(defaultRef);
        if (headOid) {
          parts.push(pktLine(`${headOid} HEAD\u0000${caps}\n`));
          first = false;
        }
        for (const [refName, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          parts.push(pktLine(first ? `${oid} ${refName}\u0000${caps}\n` : `${oid} ${refName}\n`));
          first = false;
          const peeled = store.peelOid(repo, oid);
          if (peeled) parts.push(pktLine(`${peeled} ${refName}^{}\n`));
        }
      }
      parts.push(FLUSH_BUF);
      const out = Buffer.concat(parts);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': out.length,
      });
      res.end(out);
      return;
    }

    if (service === 'git-receive-pack') {
      if (repo.receiveAdvCache !== null) {
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-advertisement',
          'content-length': repo.receiveAdvCache.length,
        });
        res.end(repo.receiveAdvCache);
        return;
      }
      const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH_BUF];
      if (repo.refs.size === 0) {
        parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_CAPS}\n`));
      } else {
        let first = true;
        for (const [refName, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          parts.push(pktLine(first ? `${oid} ${refName}\u0000${RECEIVE_CAPS}\n` : `${oid} ${refName}\n`));
          first = false;
          const peeled = store.peelOid(repo, oid);
          if (peeled) parts.push(pktLine(`${peeled} ${refName}^{}\n`));
        }
      }
      parts.push(FLUSH_BUF);
      const out = Buffer.concat(parts);
      repo.receiveAdvCache = out;
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'content-length': out.length,
      });
      res.end(out);
      return;
    }

    const msg = '{"message":"Unsupported service"}\n';
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': msg.length });
    res.end(msg);
    return;
  }

  if (method === 'POST' && subpath === '/git-upload-pack') {
    const proto = String(req.headers['git-protocol'] ?? '');
    const isProtoV2 = proto.includes('version=2');
    const rawKey = isProtoV2 ? body.toString('latin1') : '';
    if (isProtoV2) {
      const cached = repo.rawV2Cache.get(rawKey);
      if (cached !== undefined) {
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': cached.length,
        });
        res.end(cached);
        return;
      }
    }
    let packets: PktItem[];
    try {
      packets = decodePktLines(body, false).packets;
    } catch {
      const msg = '{"message":"Malformed pkt-line"}\n';
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': msg.length });
      res.end(msg);
      return;
    }
    const firstData = packets.find((p) => p.kind === 'data');
    const isV2 = isProtoV2 || (firstData?.kind === 'data' && firstData.payload.toString('utf8').startsWith('command='));
    if (isV2) {
      handleUploadPackV2(store, repo, packets, rawKey || body.toString('latin1'), res);
    } else {
      handleUploadPackV0(repo, packets, res);
    }
    return;
  }

  if (method === 'POST' && subpath === '/git-receive-pack') {
    let packets: PktItem[];
    let packOffset = 0;
    try {
      const parsed = decodePktLines(body, true);
      packets = parsed.packets;
      packOffset = parsed.offset;
    } catch {
      const msg = '{"message":"Malformed pkt-line"}\n';
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': msg.length });
      res.end(msg);
      return;
    }

    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    const caps = new Set<string>();
    let firstCmd = true;
    for (const pkt of packets) {
      if (pkt.kind !== 'data') continue;
      let line = pkt.payload.toString('utf8').replace(/\r?\n$/, '');
      if (firstCmd) {
        firstCmd = false;
        const nul = line.indexOf('\u0000');
        if (nul >= 0) {
          for (const cap of line.slice(nul + 1).split(' ')) {
            if (cap) caps.add(cap);
          }
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length >= 3 && HEX40.test(parts[0]!) && HEX40.test(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      }
    }

    const packBuf = body.subarray(packOffset);
    let unpackError: string | null = null;
    if (packBuf.length > 0) {
      try {
        unpackPack(repo, packBuf);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }

    const useSideband = caps.has('side-band-64k') || caps.has('side-band');
    let out: Buffer;
    if (
      unpackError === null &&
      useSideband &&
      commands.length === 1 &&
      commands[0]!.ref === 'refs/heads/main'
    ) {
      const cmd = commands[0]!;
      const currentOid = repo.refs.get(cmd.ref) ?? ZERO_OID;
      if (
        cmd.oldOid === currentOid &&
        cmd.newOid !== ZERO_OID &&
        repo.objects.has(cmd.newOid) &&
        (currentOid === ZERO_OID || store.isAncestor(repo, currentOid, cmd.newOid))
      ) {
        repo.refs.set(cmd.ref, cmd.newOid);
        store.invalidateRepoGitCache(repo);
        out = MAIN_OK_SIDEBAND;
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'content-length': out.length,
        });
        res.end(out);
        return;
      }
    }

    const reportLines: Buffer[] = [];
    if (unpackError !== null) {
      reportLines.push(pktLine(`unpack error ${unpackError}\n`));
      for (const cmd of commands) {
        reportLines.push(pktLine(`ng ${cmd.ref} unpack failed\n`));
      }
    } else {
      reportLines.push(pktLine('unpack ok\n'));
      let changed = false;
      for (const cmd of commands) {
        const currentOid = repo.refs.get(cmd.ref) ?? ZERO_OID;
        if (cmd.oldOid !== currentOid) {
          reportLines.push(pktLine(`ng ${cmd.ref} stale info\n`));
          continue;
        }
        if (cmd.newOid === ZERO_OID) {
          repo.refs.delete(cmd.ref);
          changed = true;
          reportLines.push(pktLine(`ok ${cmd.ref}\n`));
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(pktLine(`ng ${cmd.ref} missing object\n`));
          continue;
        }
        if (currentOid !== ZERO_OID && !store.isAncestor(repo, currentOid, cmd.newOid)) {
          reportLines.push(pktLine(`ng ${cmd.ref} non-fast-forward\n`));
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        changed = true;
        reportLines.push(pktLine(`ok ${cmd.ref}\n`));
      }
      if (changed) store.invalidateRepoGitCache(repo);
    }
    reportLines.push(FLUSH_BUF);
    const inner = Buffer.concat(reportLines);
    out = useSideband
      ? Buffer.concat([pktSideband(1, inner), FLUSH_BUF])
      : inner;

    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': out.length,
    });
    res.end(out);
    return;
  }

  const msg = '{"message":"Not Found"}\n';
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': msg.length });
  res.end(msg);
}
