// 采样表构建与逐样本 IV 提取。规格：docs/protocol/02-api-and-decryption.md §5.2-5.3。
// IV 双传输路径（senc 直读 / saiz+saio 定位辅助区）都实现——生态内两种文件真实存在。

import type { Box } from './box';
import { childBox, childBoxes, entryChildren, iterBoxes, Mp4Error, stsdEntries } from './box';

export interface TencInfo {
  defaultIVSize: number; // 8 或 16
  defaultKID: Buffer;
  constantIV: Uint8Array | null; // flags&1 时存在（无逐样本 IV 时的回退基准）
}

export interface Sample {
  offset: number;
  size: number;
}

export interface TrackInfo {
  handler: string; // 'vide' | 'soun'
  entry: Box; // stsd 内第一个条目
  entryType: string; // 'encv' | 'enca' | 'hvc1' | ...
  originalType: string; // frma 四码；无 sinf 时等于 entryType
  tenc: TencInfo | null;
  stbl: Box;
  stco: Box; // 'stco' | 'co64'
  samples: Sample[];
  ivs: Uint8Array[] | null; // 逐样本 IV（路径 A/B 任一命中）；null = 需 base IV 回退
}

export interface MoovInfo {
  moov: Box;
  tracks: TrackInfo[]; // handler ∈ {vide, soun} 的轨（其余轨跳过）
  pssh: Box[];
}

// tenc：v0 = header(4)+reserved(1)+iv_size(1)+KID(16)[+constant_IV]；v1 在 header 后多 8 字节
function parseTenc(buf: Buffer, box: Box): TencInfo | null {
  const version = buf[box.contentStart]!;
  const flags = buf.readUInt32BE(box.contentStart) & 0xffffff;
  let p = box.contentStart + 4;
  if (version === 1) p += 8;
  if (p + 18 > box.contentEnd) return null;
  const ivSize = buf[p + 1]!;
  const kid = Buffer.from(buf.subarray(p + 2, p + 18));
  if (ivSize !== 0 && ivSize !== 8 && ivSize !== 16) return null;
  let constantIV: Uint8Array | null = null;
  if (flags & 1) {
    const sz = buf[p + 18]!;
    if (sz > 0 && p + 19 + sz <= box.contentEnd) {
      constantIV = buf.subarray(p + 19, p + 19 + sz);
    }
  }
  return { defaultIVSize: ivSize, defaultKID: kid, constantIV };
}

// 路径 A：senc 直读（web mp4.js:458-488、dl:580-586）
// payload: version/flags(4) + sample_count(4) + 逐样本 [IV + (flags&2 时 subsample_count(2)+n*6)]
function parseSenc(buf: Buffer, senc: Box, ivSize: number, sampleCount: number): Uint8Array[] | null {
  const flags = buf.readUInt32BE(senc.contentStart) & 0xffffff;
  const hasSub = (flags & 2) !== 0;
  const ivs: Uint8Array[] = [];
  let p = senc.contentStart + 8;
  for (let i = 0; i < sampleCount; i++) {
    if (p + ivSize > senc.contentEnd) return null;
    ivs.push(buf.subarray(p, p + ivSize));
    p += ivSize;
    if (hasSub) {
      if (p + 2 > senc.contentEnd) return null;
      const n = buf.readUInt16BE(p);
      p += 2 + n * 6;
    }
  }
  return ivs;
}

// 路径 B：saiz/saio 定位辅助信息区（tvbox:658-686）
// saiz 给每样本记录大小，saio 给辅助区文件绝对偏移；辅助区实际就是 IV 序列，
// 每条取前 8 字节为 IV（规格 §5.3-B）。
function parseSaizSaio(
  buf: Buffer,
  stbl: Box,
  sampleCount: number,
): { ivs: Uint8Array[]; saiz: Box; saio: Box } | null {
  const saiz = childBox(buf, stbl, 'saiz');
  const saio = childBox(buf, stbl, 'saio');
  if (!saiz || !saio) return null;

  let p = saiz.contentStart + 4;
  const flags = buf.readUInt32BE(saiz.contentStart) & 0xffffff;
  if (flags & 1) p += 8; // aux_info_type + param
  const defaultSize = buf[p]!;
  const count = buf.readUInt32BE(p + 1)!;
  if (count !== sampleCount) return null;
  const sizes: number[] = [];
  if (defaultSize === 0) {
    if (p + 5 + count > saiz.contentEnd) return null;
    for (let i = 0; i < count; i++) sizes.push(buf[p + 5 + i]!);
  } else {
    // 注意：[] 上 fill 不生效，必须先建定长数组
    for (let i = 0; i < count; i++) sizes.push(defaultSize);
  }

  p = saio.contentStart + 4;
  const aioFlags = buf.readUInt32BE(saio.contentStart) & 0xffffff;
  if (aioFlags & 1) p += 8;
  const version = buf[saio.contentStart]!;
  const entryCount = buf.readUInt32BE(p)!;
  p += 4;
  const offsets: number[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (version === 1) {
      const hi = buf.readUInt32BE(p);
      offsets.push(hi * 2 ** 32 + buf.readUInt32BE(p + 4));
      p += 8;
    } else {
      offsets.push(buf.readUInt32BE(p));
      p += 4;
    }
  }
  if (offsets.length === 0) return null;

  // 辅助区记录 = IV(8) [+subsample]；按 saiz 尺寸步进，取前 8 字节
  const base = offsets[0]!;
  const ivs: Uint8Array[] = [];
  let q = base;
  for (const sz of sizes) {
    if (q + 8 > buf.length) return null;
    ivs.push(buf.subarray(q, q + 8));
    q += sz;
  }
  return { ivs, saiz, saio };
}

function parseStsz(buf: Buffer, stsz: Box): number[] {
  const fixed = buf.readUInt32BE(stsz.contentStart + 4)!;
  const count = buf.readUInt32BE(stsz.contentStart + 8)!;
  const sizes: number[] = [];
  if (fixed !== 0) {
    sizes.fill(fixed, 0, count);
  } else {
    for (let i = 0; i < count; i++) sizes.push(buf.readUInt32BE(stsz.contentStart + 12 + i * 4)!);
  }
  return sizes;
}

function parseStco(buf: Buffer, stco: Box): number[] {
  const count = buf.readUInt32BE(stco.contentStart + 4)!;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (stco.type === 'co64') {
      const hi = buf.readUInt32BE(stco.contentStart + 8 + i * 8);
      out.push(hi * 2 ** 32 + buf.readUInt32BE(stco.contentStart + 12 + i * 8));
    } else {
      out.push(buf.readUInt32BE(stco.contentStart + 8 + i * 4));
    }
  }
  return out;
}

interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
}

function parseStsc(buf: Buffer, stsc: Box): StscEntry[] {
  const count = buf.readUInt32BE(stsc.contentStart + 4)!;
  const out: StscEntry[] = [];
  for (let i = 0; i < count; i++) {
    const p = stsc.contentStart + 8 + i * 12;
    out.push({ firstChunk: buf.readUInt32BE(p)!, samplesPerChunk: buf.readUInt32BE(p + 4)! });
  }
  return out;
}

// stsc 区间展开 + chunk 内累加 → 每样本绝对偏移（规格 §5.2-3）
function buildSamples(sizes: number[], chunkOffsets: number[], stsc: StscEntry[]): Sample[] {
  const samples: Sample[] = [];
  let si = 0;
  for (let c = 0; c < chunkOffsets.length; c++) {
    let spc = 1;
    for (const e of stsc) {
      if (e.firstChunk <= c + 1) spc = e.samplesPerChunk;
      else break;
    }
    let off = chunkOffsets[c]!;
    for (let s = 0; s < spc && si < sizes.length; s++, si++) {
      samples.push({ offset: off, size: sizes[si]! });
      off += sizes[si]!;
    }
  }
  if (si !== sizes.length) throw new Mp4Error(`采样表不完整：${si}/${sizes.length}`);
  return samples;
}

export function parseMoov(buf: Buffer): MoovInfo {
  let moov: Box | undefined;
  for (const b of iterBoxes(buf, 0, buf.length)) {
    if (b.type === 'moov') {
      if (moov) throw new Mp4Error('双 moov（规格 §5.5：放弃自研路径）');
      moov = b;
    }
  }
  if (!moov) throw new Mp4Error('未找到 moov');

  const tracks: TrackInfo[] = [];
  const pssh: Box[] = childBoxes(buf, moov, 'pssh');
  for (const trak of childBoxes(buf, moov, 'trak')) {
    const mdia = childBox(buf, trak, 'mdia');
    const hdlr = mdia ? childBox(buf, mdia, 'hdlr') : undefined;
    const handler = hdlr ? buf.toString('latin1', hdlr.contentStart + 8, hdlr.contentStart + 12) : '';
    if (handler !== 'vide' && handler !== 'soun') continue;
    const minf = mdia ? childBox(buf, mdia, 'minf') : undefined;
    const stbl = minf ? childBox(buf, minf, 'stbl') : undefined;
    if (!stbl) throw new Mp4Error(`轨 ${handler} 缺 stbl`);
    const stsd = childBox(buf, stbl, 'stsd');
    const stsz = childBox(buf, stbl, 'stsz');
    const stco = childBox(buf, stbl, 'stco') ?? childBox(buf, stbl, 'co64');
    const stsc = childBox(buf, stbl, 'stsc');
    if (!stsd || !stsz || !stco || !stsc) throw new Mp4Error(`轨 ${handler} 缺基础表`);

    const entries = stsdEntries(buf, stsd);
    const entry = entries[0];
    if (!entry) throw new Mp4Error(`轨 ${handler} 无 sample entry`);

    // frma 权威 → 原始四码；缺 frma 按配置子盒推断（规格 §5.5-1）
    let originalType = entry.type;
    let tenc: TencInfo | null = null;
    for (const child of entryChildren(buf, entry)) {
      if (child.type === 'sinf') {
        const frma = childBox(buf, child, 'frma');
        if (frma && frma.contentEnd - frma.contentStart >= 4) {
          originalType = buf.toString('latin1', frma.contentStart, frma.contentStart + 4);
        }
        const schi = childBox(buf, child, 'schi');
        const t = schi ? childBox(buf, schi, 'tenc') : undefined;
        if (t) tenc = parseTenc(buf, t);
      }
    }
    if (originalType === entry.type) {
      // 无 sinf：按解码配置子盒推断（hvcC→hvc1、avcC→avc1、esds→mp4a）
      const kids = entryChildren(buf, entry).map((b) => b.type);
      if (kids.includes('hvcC')) originalType = 'hvc1';
      else if (kids.includes('avcC')) originalType = 'avc1';
      else if (kids.includes('esds')) originalType = 'mp4a';
    }
    // schm 必须是 cenc（规格 §5.1）；非 cenc 按不支持处理

    const sizes = parseStsz(buf, stsz);
    const chunkOffsets = parseStco(buf, stco);
    const samples = buildSamples(sizes, chunkOffsets, parseStsc(buf, stsc));

    let ivs: Uint8Array[] | null = null;
    const senc = childBox(buf, stbl, 'senc');
    if (senc && sizes.length > 0) {
      const ivSize = tenc?.defaultIVSize || 8;
      ivs = parseSenc(buf, senc, ivSize, sizes.length);
      if (!ivs && tenc?.defaultIVSize === 16) ivs = parseSenc(buf, senc, 8, sizes.length);
    }
    if (!ivs) {
      const b = parseSaizSaio(buf, stbl, sizes.length);
      if (b) ivs = b.ivs;
    }
    if (ivs && ivs.length !== sizes.length) ivs = null;

    tracks.push({
      handler,
      entry,
      entryType: entry.type,
      originalType,
      tenc,
      stbl,
      stco,
      samples,
      ivs,
    });
  }
  if (tracks.length === 0) throw new Mp4Error('无音视频轨');
  return { moov, tracks, pssh };
}
