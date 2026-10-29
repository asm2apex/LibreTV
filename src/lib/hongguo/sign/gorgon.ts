// X-Gorgon（规格 §3.3）：种子 20B → RC4 变种（只单向赋值不交换）→ 后处理 → 26B 输出（52 hex）。
// 输出头：0x84 0x04 || hb2 || hb3 || LE16(param)（param 小端，规格 §9.10 裁决）。
import { Buffer } from 'node:buffer';
import { md5Raw, le32, be32, assertU32, nibSwap8, reverseBits8, toHex } from './util';
import { GORGON_HEADER, SDK_NUM_HONGGUO } from './constants';

const HEX32 = /^[0-9a-fA-F]{32}$/;

export interface GorgonSeedInput {
  /** URL 问号后的原始 query 串（参与签名，字节级敏感，规格 §2.2） */
  query: string;
  khronos: number;
  /** x-ss-stub（32 hex）优先；否则 body；否则 4×0x00（规格 §3.3.1） */
  stub?: string | null;
  body?: string | null;
  cookie?: string | null;
  /** SDK 数值段：红果 0x04060400 / 番茄 0x04070100（规格 §9.1） */
  sdkNum?: number;
}

/** gorgon 种子（20B）= md5(query)[0:4] || body4 || cookie4 || LE32(SDK_NUM) || BE32(khronos) */
export function buildGorgonSeed(input: GorgonSeedInput): Uint8Array {
  const khronos = assertU32(input.khronos, 'khronos');
  const query4 = md5Raw(Buffer.from(input.query, 'utf8')).subarray(0, 4);

  let body4: Uint8Array;
  if (input.stub != null && input.stub !== '') {
    if (!HEX32.test(input.stub)) throw new TypeError('stub 必须是 32 个 hex 字符');
    body4 = Buffer.from(input.stub.slice(0, 8), 'hex');
  } else if (input.body != null && input.body !== '') {
    body4 = md5Raw(Buffer.from(input.body, 'utf8')).subarray(0, 4);
  } else {
    body4 = Buffer.alloc(4);
  }

  const cookie4 =
    input.cookie != null && input.cookie !== ''
      ? md5Raw(Buffer.from(input.cookie, 'utf8')).subarray(0, 4)
      : Buffer.alloc(4);

  return Buffer.concat([query4, body4, cookie4, le32(input.sdkNum ?? SDK_NUM_HONGGUO), be32(khronos)]);
}

/** RC4 变种（规格 §3.3.3）：KSA/PRGA 都只单向赋值不交换；keystream = S[(y+y)&0xff] */
function rc4Variant(seed: Uint8Array, key: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    s[i] = s[j]!; // 单向赋值，不交换
  }
  const out = new Uint8Array(seed.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < seed.length; n++) {
    a = (a + 1) & 0xff;
    const x = s[a]!;
    b = (b + x) & 0xff;
    const y = s[b]!;
    s[a] = y; // 单向赋值，不交换
    out[n] = seed[n]! ^ s[(y + y) & 0xff]!;
  }
  return out;
}

/**
 * 种子 → 26B 输出（规格 §3.3.2-3.3.4）。
 * 密钥骨架 [0x4A, param_lo, 0x16, hb3, 0x47, 0x6C, param_hi, hb2]；
 * 后处理顺序：半字节交换 → 与 out_next 异或 → 位反转 → ^mask(=0xEB)；
 * out_next 取 (i+1) mod 20 的当前值（i=19 时 out[0] 已转换，规格顺序处理语义）。
 */
export function transformGorgonSeed(seed: Uint8Array, hb2: number, hb3: number, parameter: number): Uint8Array {
  if (!(seed instanceof Uint8Array) || seed.length !== 20) {
    throw new TypeError(`gorgon 种子必须 20 字节，收到 ${seed.length}`);
  }
  if (!Number.isInteger(parameter) || parameter < 0 || parameter > 0xffff) {
    throw new RangeError(`parameter 必须是 [0, 2^16) 整数，收到 ${String(parameter)}`);
  }
  const key = Uint8Array.of(
    0x4a,
    parameter & 0xff,
    0x16,
    hb3 & 0xff,
    0x47,
    0x6c,
    (parameter >>> 8) & 0xff,
    hb2 & 0xff,
  );
  const out = rc4Variant(seed, key);
  const mask = (~20) & 0xff; // = 0xEB
  for (let i = 0; i < 20; i++) {
    const v = nibSwap8(out[i]!);
    const next = i < 19 ? out[i + 1]! : out[0]!; // i=19 取已转换的 out[0]
    out[i] = reverseBits8((v ^ next) & 0xff) ^ mask;
  }
  const header = Buffer.concat([GORGON_HEADER, Buffer.from([hb2 & 0xff, hb3 & 0xff]), Buffer.from([parameter & 0xff, (parameter >>> 8) & 0xff])]);
  return Buffer.concat([header, out]);
}

/** 完整 x-gorgon（52 个小写 hex） */
export function gorgon(input: GorgonSeedInput, hb2: number, hb3: number, parameter: number): string {
  const seed = buildGorgonSeed(input);
  return toHex(transformGorgonSeed(seed, hb2, hb3, parameter));
}

/** 从完整 URL 提取问号后的原始 query 串（无问号则空串） */
export function queryStringOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? '' : url.slice(q + 1);
}
