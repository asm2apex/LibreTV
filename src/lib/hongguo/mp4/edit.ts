// moov 盒树编辑器：删盒 / entry 四码改名 / 追加盒，并记录 stco/co64 平移位点。
// 剥壳（patch.ts）与测试用 CENC 加密器（test/support/cenc-fixture.ts）共用同一
// 机制——"加密器构造的布局"与"剥壳器接受的布局"因此互为镜像，这是回环测试
// 可以做字节级 deepEqual 的依据。规格：docs/protocol/02-api-and-decryption.md §5.5。

import type { Box } from './box';
import { entryChildren, entryHeaderSize, iterBoxes, Mp4Error } from './box';
import type { MoovInfo, TrackInfo } from './tables';

export interface EntryEdit {
  renameTo?: string; // entry 四码改名（encv→hvc1 / hvc1→encv）
  removeChildren?: string[]; // entry 子盒删除（剥壳：sinf）
  appendChildren?: Buffer[]; // entry 子盒追加（加密：sinf）
}

export interface StblEdit {
  remove?: string[];
  removeWhen?: (box: Box) => boolean; // 条件删除（如仅 grouping_type=='seig' 的 sgpd/sbgp）
  append?: Buffer[];
}

export interface RebuildSpec {
  entry?: (track: TrackInfo) => EntryEdit | null;
  stbl?: (track: TrackInfo) => StblEdit | null;
  moov?: { remove?: string[]; append?: Buffer[] };
}

// stco/co64 条目区在输出 moov 内的位置（相对输出缓冲起点）
export interface StcoPatchPos {
  pos: number;
  is64: boolean;
  count: number;
}

interface SerOut {
  bytes: Buffer;
  stco: StcoPatchPos[];
}

const PLAIN_CONTAINERS = new Set(['trak', 'mdia', 'minf', 'edts', 'dinf']);

function leaf(bytes: Buffer): SerOut {
  return { bytes, stco: [] };
}

function withHeader(type: string, child: SerOut): SerOut {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(child.bytes.length + 8, 0);
  h.write(type, 4, 'latin1');
  for (const p of child.stco) p.pos += 8;
  return { bytes: Buffer.concat([h, child.bytes]), stco: child.stco };
}

function concatParts(parts: SerOut[]): SerOut {
  const stco: StcoPatchPos[] = [];
  let off = 0;
  for (const p of parts) {
    for (const s of p.stco) {
      s.pos += off;
      stco.push(s);
    }
    off += p.bytes.length;
  }
  return { bytes: Buffer.concat(parts.map((p) => p.bytes)), stco };
}

interface Ctx {
  spec: RebuildSpec;
  entryEdits: Map<number, EntryEdit>; // key: entry.start
  stblEdits: Map<number, StblEdit>; // key: stbl.start
}

function serStco(buf: Buffer, box: Box): SerOut {
  const bytes = Buffer.from(buf.subarray(box.start, box.contentEnd));
  const count = buf.readUInt32BE(box.contentStart + 4)!;
  // 条目区盒内偏移：头 8 + version/flags 4 + count 4 = 16
  return { bytes, stco: [{ pos: 16, is64: box.type === 'co64', count }] };
}

function serEntry(buf: Buffer, entry: Box, ctx: Ctx): SerOut {
  const edit = ctx.entryEdits.get(entry.start);
  if (!edit) return leaf(Buffer.from(buf.subarray(entry.start, entry.contentEnd)));
  const hdr = entryHeaderSize(entry.type);
  if (entry.contentStart + hdr > entry.contentEnd) throw new Mp4Error(`entry 头越离 ${entry.type}`);
  const parts: SerOut[] = [leaf(Buffer.from(buf.subarray(entry.contentStart, entry.contentStart + hdr)))];
  const rm = new Set(edit.removeChildren ?? []);
  for (const c of entryChildren(buf, entry)) {
    if (!rm.has(c.type)) parts.push(leaf(Buffer.from(buf.subarray(c.start, c.contentEnd))));
  }
  for (const extra of edit.appendChildren ?? []) parts.push(leaf(extra));
  return withHeader(edit.renameTo ?? entry.type, concatParts(parts));
}

function serBox(buf: Buffer, box: Box, ctx: Ctx): SerOut {
  if (box.type === 'moov') {
    const rm = new Set(ctx.spec.moov?.remove ?? []);
    const parts: SerOut[] = [];
    for (const c of iterBoxes(buf, box.contentStart, box.contentEnd)) {
      if (!rm.has(c.type)) parts.push(serBox(buf, c, ctx));
    }
    for (const extra of ctx.spec.moov?.append ?? []) parts.push(leaf(extra));
    return withHeader('moov', concatParts(parts));
  }
  if (PLAIN_CONTAINERS.has(box.type)) {
    const parts = [...iterBoxes(buf, box.contentStart, box.contentEnd)].map((c) => serBox(buf, c, ctx));
    return withHeader(box.type, concatParts(parts));
  }
  if (box.type === 'stbl') {
    const edit = ctx.stblEdits.get(box.start);
    const rm = new Set(edit?.remove ?? []);
    const when = edit?.removeWhen;
    const parts: SerOut[] = [];
    for (const c of iterBoxes(buf, box.contentStart, box.contentEnd)) {
      if (rm.has(c.type)) continue;
      if (when && when(c)) continue;
      parts.push(serBox(buf, c, ctx));
    }
    for (const extra of edit?.append ?? []) parts.push(leaf(extra));
    return withHeader('stbl', concatParts(parts));
  }
  if (box.type === 'stsd') {
    // version/flags(4) + entry_count(4) 前缀原样保留
    const parts: SerOut[] = [leaf(Buffer.from(buf.subarray(box.contentStart, box.contentStart + 8)))];
    for (const e of iterBoxes(buf, box.contentStart + 8, box.contentEnd)) {
      parts.push(serEntry(buf, e, ctx));
    }
    return withHeader('stsd', concatParts(parts));
  }
  if (box.type === 'stco' || box.type === 'co64') return serStco(buf, box);
  return leaf(Buffer.from(buf.subarray(box.start, box.contentEnd)));
}

export function rebuildMoov(buf: Buffer, info: MoovInfo, spec: RebuildSpec): SerOut {
  const ctx: Ctx = { spec, entryEdits: new Map(), stblEdits: new Map() };
  for (const t of info.tracks) {
    const e = spec.entry?.(t) ?? null;
    if (e) ctx.entryEdits.set(t.entry.start, e);
    const s = spec.stbl?.(t) ?? null;
    if (s) ctx.stblEdits.set(t.stbl.start, s);
  }
  return serBox(buf, info.moov, ctx);
}

/**
 * 平移 stco/co64 条目。regionStart/End = 原 moov 区间：
 * - v >= regionEnd：位于 moov 之后，整体 +shift
 * - regionStart <= v < regionEnd：chunk 落在 moov 内，布局不支持，抛错
 * - v < regionStart：moov 后置文件的 mdat 在前，位置不变
 */
export function patchStco(
  moovOut: Buffer,
  patches: StcoPatchPos[],
  shift: number,
  regionStart: number,
  regionEnd: number,
): void {
  for (const p of patches) {
    const w = p.is64 ? 8 : 4;
    for (let i = 0; i < p.count; i++) {
      const pos = p.pos + i * w;
      const v = p.is64
        ? moovOut.readUInt32BE(pos) * 2 ** 32 + moovOut.readUInt32BE(pos + 4)
        : moovOut.readUInt32BE(pos);
      if (v >= regionEnd) {
        const nv = v + shift;
        if (nv < 0) throw new Mp4Error('stco 平移后为负');
        if (p.is64) {
          moovOut.writeUInt32BE(Math.floor(nv / 2 ** 32), pos);
          moovOut.writeUInt32BE(nv % 2 ** 32, pos + 4);
        } else {
          if (nv > 0xffffffff) throw new Mp4Error('stco 32 位溢出（需 co64）');
          moovOut.writeUInt32BE(nv, pos);
        }
      } else if (v >= regionStart) {
        throw new Mp4Error(`chunk offset ${v} 落在 moov 区间内，布局不支持`);
      }
    }
  }
}
