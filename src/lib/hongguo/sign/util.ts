// 共享基础原语：u32/u64 位运算、md5/hex/base64、PKCS7、字节变换。
// 语义全部按规格 §3 约定：u32/u64 加乘按 2^32/2^64 截断；u64 内部用 BigInt，接口保持 number。
// 零第三方依赖（node:crypto / node:buffer）。
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function md5Raw(data: Uint8Array): Buffer {
  return createHash('md5').update(data).digest();
}

export function md5HexLower(data: Uint8Array): string {
  return md5Raw(data).toString('hex');
}

export function utf8(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function le32(n: number): Buffer {
  return Buffer.from([(n >>> 0) & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function be32(n: number): Buffer {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function le16(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
}

export function readU32LE(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

export function readU64LE(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}

export function le64(x: bigint): Buffer {
  const out = Buffer.alloc(8);
  let v = x & 0xffffffffffffffffn;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export const M64 = 0xffffffffffffffffn;

export function rotl64(x: bigint, n: number): bigint {
  const s = BigInt(n & 63);
  if (s === 0n) return x & M64;
  return ((x << s) | (x >> (64n - s))) & M64;
}

export function rotr64(x: bigint, n: number): bigint {
  const s = BigInt(n & 63);
  if (s === 0n) return x & M64;
  return ((x >> s) | (x << (64n - s))) & M64;
}

export function rol32(x: number, n: number): number {
  const s = n & 31;
  return s === 0 ? x >>> 0 : ((x << s) | (x >>> (32 - s))) >>> 0;
}

export function ror32(x: number, n: number): number {
  const s = n & 31;
  return s === 0 ? x >>> 0 : ((x >>> s) | (x << (32 - s))) >>> 0;
}

// khronos 等时间量合法性：[0, 2^32) 整数（规格 §7.1 [DT] 用例：-1/1.5/2^32/字符串/null 抛 RangeError）
export function assertU32(n: number, name: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`${name} 必须是 [0, 2^32) 的整数，收到: ${String(n)}`);
  }
  return n;
}

// 标准 PKCS7（对齐时补整块）——ladon/helios（§3.4.1，按规格 §9.4 建议取标准语义）与 argus（§3.5.3/§9.7）共用
export function pkcs7(data: Uint8Array, block = 16): Buffer {
  const pad = block - (data.length % block);
  return Buffer.concat([Buffer.from(data), Buffer.alloc(pad, pad)]);
}

export function nibSwap8(b: number): number {
  return ((b << 4) | (b >> 4)) & 0xff;
}

export function rotl8(b: number, n: number): number {
  const s = n & 7;
  return s === 0 ? b & 0xff : ((b << s) | (b >> (8 - s))) & 0xff;
}

// 8 位位反转查表（乘法位技巧易错，直接建表）
const REVERSE_BITS8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    let r = 0;
    for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
    t[b] = r;
  }
  return t;
})();

export function reverseBits8(b: number): number {
  return REVERSE_BITS8_TABLE[b & 0xff]!;
}

// ===== protobuf 编码原语（规格 §3.5.1/§3.6.2，自写 varint/zigzag）=====

/** 无符号 varint（protobuf wire 0） */
export function pbVarint(v: number): Buffer {
  if (!Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`varint 值非法: ${String(v)}`);
  }
  const out: number[] = [];
  let n = v;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

/** zigzag（sint32/sint64 语义）：正数 v → 2v，负数 v → -2v-1（规格 §3.5.1 "先 (v<<1)（正数）"） */
export function pbZigzag(v: number): number {
  if (!Number.isInteger(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER / 2) {
    throw new RangeError(`zigzag 值非法: ${String(v)}`);
  }
  return v >= 0 ? v * 2 : (-v) * 2 - 1;
}

export function pbTag(field: number, wire: number): Buffer {
  return pbVarint((field << 3) | wire);
}

/** wire 2（bytes/string/嵌套消息） */
export function pbBytes(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([pbTag(field, 2), pbVarint(value.length), Buffer.from(value)]);
}

export function pbString(field: number, value: string): Buffer {
  return pbBytes(field, utf8(value));
}

/** wire 0 varint 字段（0 值按 [P] 语义保留，规格 §9.6） */
export function pbVarintField(field: number, value: number): Buffer {
  return Buffer.concat([pbTag(field, 0), pbVarint(value)]);
}

/** zigzag varint 字段 */
export function pbZigzagField(field: number, value: number): Buffer {
  return Buffer.concat([pbTag(field, 0), pbVarint(pbZigzag(value))]);
}

/** wire 5 fixed32 LE（float 字段） */
export function pbFloatField(field: number, value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value, 0);
  return Buffer.concat([pbTag(field, 5), b]);
}
