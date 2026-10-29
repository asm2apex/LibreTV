// CENC 逐样本解密 + key 自证。规格：docs/protocol/02-api-and-decryption.md §5.4。
// 每样本独立 CTR 计数器：8 字节 IV → counter = IV||8 零（IV 居高 64 位）；
// 16 字节 IV → counter = IV。全样本加密假设（真实样本 verify 通过即成立）。

import { createDecipheriv } from 'node:crypto';
import type { TrackInfo } from './tables';

export function ivToCounter(iv: Uint8Array): Buffer {
  if (iv.length === 8) return Buffer.concat([Buffer.from(iv), Buffer.alloc(8)]);
  if (iv.length === 16) return Buffer.from(iv);
  throw new Error(`IV 长度非法: ${iv.length}`);
}

// 无逐样本 IV 时的回退：base 高 64 位 + i（规格 §5.4 末段）
export function incrementIv(base: Uint8Array, i: number): Uint8Array {
  const out = Buffer.from(base);
  const add = (b: Buffer, n: number) => {
    let carry = n;
    for (let p = 7; p >= 0 && carry > 0; p--) {
      const v = b[p]! + (carry & 0xff);
      b[p] = v & 0xff;
      carry = (carry >> 8) + (v >> 8);
    }
  };
  add(out, i);
  return out;
}

// 原地解密单个样本（CTR 加解密同构）
export function decryptSampleInPlace(buf: Buffer, offset: number, size: number, key: Buffer, iv: Uint8Array): void {
  if (size === 0) return;
  const d = createDecipheriv('aes-128-ctr', key, ivToCounter(iv));
  const out = d.update(buf.subarray(offset, offset + size));
  if (out.length !== size) throw new Error('CTR 输出长度不符');
  out.copy(buf, offset);
}

function trackIv(track: TrackInfo, i: number): Uint8Array {
  if (track.ivs && track.ivs[i]) return track.ivs[i]!;
  const base = track.tenc?.constantIV;
  if (!base) throw new Error(`轨 ${track.handler} 无逐样本 IV 也无 constant IV`);
  return incrementIv(base, i);
}

// AVCC/Annex-B 链走查：4 字节大端 NAL 长度精确吃满样本（规格 §5.4 verify）
function looksLikeNalSample(s: Buffer): boolean {
  if (s.length >= 4 && s[0] === 0 && s[1] === 0 && (s[2] === 1 || (s[2] === 0 && s[3] === 1))) {
    return true; // Annex-B 起始码
  }
  let pos = 0;
  while (pos < s.length) {
    if (pos + 4 > s.length) return false;
    const len = s.readUInt32BE(pos);
    pos += 4;
    if (len === 0 || pos + len > s.length) return false;
    pos += len;
  }
  return pos === s.length;
}

/**
 * key 自证（verify-before-decrypt）：对视频轨探测 ≥8 个样本，解密副本后做
 * NAL 链走查，全部通过才返回 true。必须先 verify 后全量解——顺序颠倒时
 * 样本 0 已是明文，错误 key 也会通过校验（规格 §5.4 警告）。
 */
export function verifyKey(buf: Buffer, track: TrackInfo, key: Buffer): boolean {
  if (track.handler !== 'vide') throw new Error('verify 只对视频轨');
  const n = track.samples.length;
  if (n === 0) return false;
  const idx = new Set<number>([0, 1, 2, n >> 2, n >> 1, n - 3, n - 2, n - 1]);
  for (const i of idx) {
    if (i < 0 || i >= n) continue;
    const s = track.samples[i]!;
    const copy = Buffer.from(buf.subarray(s.offset, s.offset + s.size));
    decryptSampleInPlace(copy, 0, copy.length, key, trackIv(track, i));
    if (!looksLikeNalSample(copy)) return false;
  }
  return true;
}

/** 全轨逐样本原地解密（音视频同 key，规格 §5.4）。 */
export function decryptTrack(buf: Buffer, track: TrackInfo, key: Buffer): void {
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i]!;
    decryptSampleInPlace(buf, s.offset, s.size, key, trackIv(track, i));
  }
}
