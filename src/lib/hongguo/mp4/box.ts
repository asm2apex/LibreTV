// MP4 box 解析原语。规格：docs/protocol/02-api-and-decryption.md §5.1。
// 只实现本场景需要的子集：非 fragmented MP4（无 moof），容器盒树遍历 +
// stsd 条目子盒访问。所有读取带越界检查，畸形输入抛 Mp4Error 而非静默。

export class Mp4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp4Error';
  }
}

export interface Box {
  type: string; // fourcc
  start: number; // 盒头起始绝对偏移
  size: number; // 盒总长（含头）
  contentStart: number; // 头后内容起始
  contentEnd: number; // start + size
}

const HDR = 8;

export function readBoxHeader(buf: Buffer, pos: number, end: number): Box {
  if (pos + HDR > end) throw new Mp4Error(`box 头越界 @${pos}`);
  const v0 = buf.readUInt32BE(pos);
  const type = buf.toString('latin1', pos + 4, pos + 8);
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Mp4Error(`非 fourcc @${pos}: ${JSON.stringify(type)}`);
  let size = v0;
  let contentStart = pos + HDR;
  if (v0 === 1) {
    if (pos + HDR + 8 > end) throw new Mp4Error('largesize 越界');
    const hi = buf.readUInt32BE(pos + 8);
    const lo = buf.readUInt32BE(pos + 12);
    size = hi * 2 ** 32 + lo;
    contentStart = pos + HDR + 8;
  } else if (v0 === 0) {
    size = end - pos; // size==0：延伸到区段尾（规格 §5.1）
  }
  if (size < contentStart - pos) throw new Mp4Error(`box size 异常 @${pos} ${type}`);
  if (pos + size > end) throw new Mp4Error(`box 越界 @${pos} ${type} size=${size}`);
  return { type, start: pos, size, contentStart, contentEnd: pos + size };
}

export function* iterBoxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos < end) {
    const b = readBoxHeader(buf, pos, end);
    yield b;
    pos = b.contentEnd;
  }
}

export function childBox(buf: Buffer, parent: Box, type: string): Box | undefined {
  for (const b of iterBoxes(buf, parent.contentStart, parent.contentEnd)) {
    if (b.type === type) return b;
  }
  return undefined;
}

export function childBoxes(buf: Buffer, parent: Box, type: string): Box[] {
  const out: Box[] = [];
  for (const b of iterBoxes(buf, parent.contentStart, parent.contentEnd)) {
    if (b.type === type) out.push(b);
  }
  return out;
}

// 音频 sample entry 的固定头长（reserved6+dri2+音频段20），视频为 78。
// 数值依据 ISO 14496-12/14；对真实样本的验证见 tables.test.ts。
const AUDIO_ENTRIES = new Set(['enca', 'mp4a', 'ac-3', 'ec-3']);
export function entryHeaderSize(entryType: string): number {
  return AUDIO_ENTRIES.has(entryType) ? 28 : 78;
}

// stsd：version/flags(4) + entry_count(4) 后跟 sample entry 盒
export function stsdEntries(buf: Buffer, stsd: Box): Box[] {
  return [...iterBoxes(buf, stsd.contentStart + 8, stsd.contentEnd)];
}

// sample entry 的子盒（hvcC/avcC/esds/sinf...），跳过 entry 类型相关固定头
export function entryChildren(buf: Buffer, entry: Box): Box[] {
  const hdr = entryHeaderSize(entry.type);
  if (entry.contentStart + hdr > entry.contentEnd) throw new Mp4Error(`entry 头越界 ${entry.type}`);
  return [...iterBoxes(buf, entry.contentStart + hdr, entry.contentEnd)];
}
