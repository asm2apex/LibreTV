// X-Argus（规格 §3.5，番茄语境常量）：protobuf 载荷 → PKCS7 → Simon 类 ECB（m=4/72 轮/z4，
// 非官方参数组合，勿用 Simon 库）→ XOR 段/逆序组装 → AES-128-CBC。
// 注意：x-ss-stub 优先作为 bodyIn；无 stub 无 body → 16×0x00（§3.5.1 f13）。
import { createCipheriv } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { sm3 } from './sm3';
import { md5Raw, utf8, pkcs7, readU64LE, le64, rotl64, rotr64, M64, assertU32, toHex } from './util';
import type { Buffer as BufferT } from 'node:buffer';
import {
  ARGUS_SIGN_KEY,
  ARGUS_HEADER,
  ARGUS_PREFIX,
  ARGUS_SUFFIX,
  ARGUS_XOR_WORD,
  ARGUS_SDK_VERSION,
  ARGUS_COUNTER_VALUE,
  SIMON_Z4,
  ARGUS_METASEC_APP_ID_STR,
  ARGUS_LICENSE_ID_STR,
  ARGUS_EMBEDDED_SDK_VER,
  ARGUS_SDK_STR_FANQIE,
} from './constants';
import { pbVarintField, pbZigzagField, pbBytes, pbString } from './util';

const HEX32 = /^[0-9a-fA-F]{32}$/;
const ARGUS_DATE = 0x20200929; // f1：日期 2020-09-29（§3.5.1）

export interface ArgusInput {
  /** URL 问号后的原始 query 串 */
  query: string;
  khronos: number;
  /** x-ss-stub（32 hex）优先；否则 md5(body)；否则 16×0x00 */
  stub?: string | null;
  body?: string | null;
  /** 随机 u32（proto f3，可注入） */
  random: number;
  /** 偶数 2..98（proto f15.1） */
  signCount: number;
}

function buildProtobuf(input: ArgusInput): Buffer {
  let bodyIn: Uint8Array;
  if (input.stub != null && input.stub !== '') {
    if (!HEX32.test(input.stub)) throw new TypeError('stub 必须是 32 个 hex 字符');
    bodyIn = Buffer.from(input.stub, 'hex');
  } else if (input.body != null && input.body !== '') {
    bodyIn = md5Raw(Buffer.from(input.body, 'utf8'));
  } else {
    bodyIn = Buffer.alloc(16);
  }
  const nested15 = Buffer.concat([
    pbVarintField(1, input.signCount),
    pbVarintField(2, ARGUS_COUNTER_VALUE),
    pbVarintField(3, ARGUS_COUNTER_VALUE),
    pbVarintField(4, ARGUS_COUNTER_VALUE),
  ]);
  return Buffer.concat([
    pbZigzagField(1, ARGUS_DATE), // varint(zigzag)
    pbVarintField(2, 2),
    pbVarintField(3, input.random),
    pbString(4, ARGUS_METASEC_APP_ID_STR),
    pbString(6, ARGUS_LICENSE_ID_STR),
    pbString(7, ARGUS_EMBEDDED_SDK_VER),
    pbString(8, ARGUS_SDK_STR_FANQIE),
    pbVarintField(9, ARGUS_SDK_VERSION),
    pbBytes(10, Buffer.alloc(8)), // 8×0x00，空 bytes 仍编码（§3.5.1）
    pbZigzagField(12, input.khronos),
    pbBytes(13, sm3(Buffer.from(bodyIn)).subarray(0, 6)),
    pbBytes(14, sm3(utf8(input.query)).subarray(0, 6)),
    pbBytes(15, nested15),
    pbString(20, 'none'),
    pbVarintField(21, 738),
  ]);
}

/** Simon 类密钥扩展（规格 §3.5.2）：m=4 词、72 轮、常数 3、z4 位序从最低位起数 */
function simonExpand(simonKey: Uint8Array): bigint[] {
  const w: bigint[] = [];
  for (let i = 0; i < 4; i++) w.push(readU64LE(simonKey, i * 8));
  for (let i = 4; i < 72; i++) {
    let t = rotr64(w[i - 1]!, 3) ^ w[i - 3]!;
    t = t ^ rotr64(t, 1);
    const zBit = (SIMON_Z4 >> BigInt((i - 4) % 62)) & 1n;
    w.push((~w[i - 4]! & M64) ^ t ^ zBit ^ 3n);
  }
  return w;
}

/** Simon128 标准轮函数（16B 块，72 轮） */
function simonEncryptBlock(w: readonly bigint[], blk: Uint8Array): BufferT {
  let x = readU64LE(blk, 0);
  let y = readU64LE(blk, 8);
  for (const k of w) {
    const nx = y;
    const ny = x ^ ((rotl64(y, 1) & rotl64(y, 8)) ^ rotl64(y, 2) ^ k);
    x = nx;
    y = ny;
  }
  return Buffer.concat([le64(x), le64(y)]);
}

/** 完整 x-argus（标准 base64） */
export function argus(input: ArgusInput): string {
  assertU32(input.khronos, 'khronos');
  assertU32(input.random, 'argusRandom');
  if (!Number.isInteger(input.signCount) || input.signCount < 0 || input.signCount > 0xffffffff) {
    throw new RangeError(`signCount 非法: ${String(input.signCount)}`);
  }
  const proto = buildProtobuf(input);
  const data = pkcs7(proto); // 标准 PKCS7（对齐补整块，§9.7 假定）

  // simonKey = SM3(SIGN_KEY || 3c cc 56 7b || SIGN_KEY)，68B 输入（§3.5.3）
  const simonKeyInput = Buffer.concat([
    ARGUS_SIGN_KEY,
    Buffer.from([0x3c, 0xcc, 0x56, 0x7b]),
    ARGUS_SIGN_KEY,
  ]);
  const w = simonExpand(sm3(simonKeyInput));

  const blocks: Buffer[] = [];
  for (let off = 0; off < data.length; off += 16) {
    blocks.push(simonEncryptBlock(w, data.subarray(off, off + 16)));
  }
  const xor8 = Buffer.from([...ARGUS_XOR_WORD, ...ARGUS_XOR_WORD]);
  const buf = Buffer.concat([xor8, ...blocks]);
  for (let i = 8; i < buf.length; i++) buf[i] ^= buf[i % 8]!;

  const container = Buffer.concat([ARGUS_PREFIX, Buffer.from(buf).reverse(), ARGUS_SUFFIX]);

  const key = md5Raw(ARGUS_SIGN_KEY.subarray(0, 16));
  const iv = md5Raw(ARGUS_SIGN_KEY.subarray(16, 32));
  // AES-128-CBC 标准自动 PKCS7 填充（§9.7：payload 124B 非对齐，向量按此假定产出并验证）
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(container), cipher.final()]);

  return Buffer.concat([ARGUS_HEADER, enc]).toString('base64');
}

// 仅供调试：protobuf 载荷 hex（测试断言长度用）
export function argusProtobufHex(input: ArgusInput): string {
  return toHex(buildProtobuf(input));
}
