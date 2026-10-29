// SM3 杂凑（规格 §3.1）：与国标 GB/T 32905-2016 完全一致，无魔改。
// Node 的 OpenSSL 若带 sm3 则直接用内置（规格注：[P:33-37] 即此做法）；否则回退到本文件
// 的国标纯 JS 实现。两条路径由 sm3.test.ts 用标准向量 SM3("abc") 双向锚定。
// 标准向量：SM3("abc") = 66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
import { createHash, getHashes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { rol32 } from './util';

const HAS_BUILTIN_SM3 = getHashes().includes('sm3');

const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

// 国标纯实现（GB/T 32905-2016）：标准 T_j / P0 / P1 / FF / GG、0x80 填充 + 大端 64 位比特长度。
export function sm3Pure(data: Uint8Array): Uint8Array {
  const bitLen = BigInt(data.length) * 8n;
  // 0x80 后补零至 length ≡ 56 (mod 64)，再接大端 64 位比特长度
  const zeros = (56 - ((data.length + 1) % 64) + 64) % 64;
  const lenBytes = Buffer.alloc(8);
  lenBytes.writeBigUInt64BE(bitLen);
  const msg = Buffer.concat([Buffer.from(data), Buffer.from([0x80]), Buffer.alloc(zeros), lenBytes]);

  const v = [...IV];
  const w = new Array<number>(68);
  const wp = new Array<number>(64);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = msg.readUInt32BE(off + i * 4);
    }
    for (let j = 16; j < 68; j++) {
      const x = w[j - 16]! ^ w[j - 9]! ^ rol32(w[j - 3]!, 15);
      const p1 = x ^ rol32(x, 15) ^ rol32(x, 23);
      w[j] = p1 ^ rol32(w[j - 13]!, 7) ^ w[j - 6]!;
    }
    for (let j = 0; j < 64; j++) wp[j] = w[j]! ^ w[j + 4]!;

    let [a, b, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j++) {
      const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rol32((rol32(a, 12) + e + rol32(t, j % 32)) >>> 0, 7);
      const ss2 = ss1 ^ rol32(a, 12);
      const ff = j < 16 ? a ^ b ^ c : ((a & b) | (a & c) | (b & c)) >>> 0;
      const gg = j < 16 ? e ^ f ^ g : ((e & f) | (~e & g)) >>> 0;
      const tt1 = (ff + d + ss2 + wp[j]!) >>> 0;
      const tt2 = (gg + h + ss1 + w[j]!) >>> 0;
      d = c;
      c = rol32(b, 9);
      b = a;
      a = tt1;
      h = g;
      g = rol32(f, 19);
      f = e;
      const p0 = tt2 ^ rol32(tt2, 9) ^ rol32(tt2, 17);
      e = p0;
    }
    const nr = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) v[i] = (v[i]! ^ nr[i]!) >>> 0;
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32BE(v[i]!, i * 4);
  return out;
}

export function sm3(data: Uint8Array): Uint8Array {
  if (HAS_BUILTIN_SM3) return createHash('sm3').update(data).digest();
  return sm3Pure(data);
}

export const sm3UsesBuiltin = HAS_BUILTIN_SM3;
