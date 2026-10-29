// X-Medusa（规格 §3.6，红果语境）：
// SM3(query)+md5(body) → hashF13（分支哈希；branch 1 不实现——调用方抖 _rticket 规避，§3.6.1/§6.2）
// → protobuf 消息 → xmxor 混淆 → 组装（LE64(320) 前缀/逆序/seed4 异或）→ AesV3 → base64。
// 设备采样值跟随 [P] 路线（规格 §9.6：0.0 float + 进程启动时间，无 2024 固定时间戳指纹）；
// 0 值数值字段保留、空串/null 省略（[P] 编码语义，规格 §3.6.2+§9.6）。
import { Buffer } from 'node:buffer';
import { sm3 } from './sm3';
import {
  md5Raw,
  utf8,
  le32,
  readU32LE,
  rol32,
  ror32,
  nibSwap8,
  rotl8,
  assertU32,
  pbZigzagField,
  pbBytes,
  pbString,
  pbFloatField,
} from './util';
import {
  GET_IV_INIT,
  SUM_MD5_INIT,
  TT01,
  TT02,
  INIT8,
  CHOSEN,
  BRANCH0_PAD_SEED,
  B2_T001,
  SV2,
  B2_START4,
  B2_END4,
  BRANCH2_PAD_SEED8,
  B2ORDERS,
  SBOX1024,
  AES_V3_INIT,
  AES_V3_CON2,
  AES_V3_ORDERS,
  MEDUSA_SIGN_KEY,
  MEDUSA_AES_KEY,
  MEDUSA_AES_IV,
  MEDUSA_MAGIC16,
  MEDUSA_MAGIC8,
  MEDUSA_VER,
  MEDUSA_AID_STR,
  MEDUSA_LICENSE_STR,
  MEDUSA_VERSION_NAME,
  MEDUSA_SDK_STR,
  MEDUSA_SDK_NUM,
  MEDUSA_CALL_TYPE,
  MEDUSA_PSK,
  MEDUSA_FIXED_JSON,
  MEDUSA_F15,
  ENV_UNKNOWN2,
  ENV_UNKNOWN3,
  ENV_UNKNOWN5,
  ENV_SDK_BUGFIX,
  ENV_REPORT_STATE,
  ENV_REPORT_CODE,
  DEVICE_NO_PERM,
  DEVICE_BATTERY,
  DEVICE_BATTERY_HEALTH,
  DEVICE_NOT_SET,
  DEVICE_TZ,
  DEVICE_LANG,
  DEVICE_CPU,
  DEVICE_OS_VERSION,
  DEVICE_BRIGHTNESS,
  DEVICE_VOLUME,
  DEVICE_USB,
  DEVICE_MODEL,
  DEVICE_BOARD,
  DEVICE_MANUFACTURER,
  DEVICE_BRAND,
  DEVICE_HARDWARE,
  DEVICE_UNKNOWN38,
} from './constants';

// ===== hashF13（规格 §3.6.1）=====

/** 32 位状态机：偶下标 (iv>>>4)^iv^(iv<<6)^b；奇下标 ~((iv>>>7)^iv^(b|(iv<<12)))；每步 u32 截断 */
export function getIv(iv: number, data: Uint8Array): number {
  let v = iv >>> 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (i % 2 === 0) {
      v = (((v >>> 4) ^ v ^ (v << 6) ^ b) & 0xffffffff) >>> 0;
    } else {
      v = ~((v >>> 7) ^ v ^ (b | (v << 12))) >>> 0;
    }
  }
  return v >>> 0;
}

/** iv 链：0x20230928 → querySm3 → bodyMd5 → LE32(khronos)，返回最终 iv（低 4 位定分支） */
function ivChain(querySm3: Uint8Array, bodyMd5: Uint8Array, khronos: number): number {
  return getIv(getIv(getIv(GET_IV_INIT, querySm3), bodyMd5), le32(khronos));
}

export interface BranchInfo {
  iv: number;
  low: number;
  ivV0: number;
  branch: 0 | 1 | 2;
}

export function branchInfoOf(querySm3: Uint8Array, bodyMd5: Uint8Array, khronos: number): BranchInfo {
  const iv = ivChain(querySm3, bodyMd5, khronos);
  const low = iv & 15;
  const ivV0 = (low * 171) >> 9;
  const branch = (low - ivV0 * 3) as 0 | 1 | 2;
  return { iv, low, ivV0, branch };
}

/** 4 字节校验和（两分支共用，规格 §3.6.1 sumMd5） */
export function sumMd5(data: Uint8Array): number {
  let c = SUM_MD5_INIT;
  for (let i = 0; i < 12; i++) {
    const t = i % 2 === 0 ? ((c >>> 3) ^ c) >>> 0 : ((c >>> 5) ^ c) >>> 0;
    if (i % 2 === 0) {
      c = data[i]! ^ ((c << 7) & 0xffffffff);
    } else {
      c = data[i]! | ((c << 11) & 0xffffffff);
      c = (~c & 0xffffffff) >>> 0;
    }
    c = (c ^ t) & 0xffffffff;
  }
  c |= 4;
  c ^= 0x1000000;
  return c >>> 0;
}

/** branch 0：SHA-256 风格自定义轮函数（规格 §3.6.1）；返回 20B */
export function branch0(
  ivV0: number,
  khronos: number,
  querySm3: Uint8Array,
  bodyMd5: Uint8Array,
  tsBytes: Uint8Array,
): Uint8Array {
  const ivV1 = TT01[ivV0]!;
  const cV1 = (ivV1 + khronos + 1) & 0xff;
  const cV2 = (ivV1 + khronos) >>> 0;

  const tt = TT02.map((x) => ror32(x, cV1)); // tt[i] = ror32(TT02[i], cV1)

  const shift = (cV2 + 2) & 7;
  const pad4 = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const v = BRANCH0_PAD_SEED[i]! | (BRANCH0_PAD_SEED[i]! << 8); // u16LE(seed[i],seed[i])
    pad4[i] = (v >> shift) & 0xff;
  }

  const init = INIT8.map((x) => ror32(x, cV2 & 31));

  const data = Buffer.concat([
    Buffer.from(querySm3),
    Buffer.from(bodyMd5),
    Buffer.from(tsBytes),
    pad4,
    Buffer.from([0, 0, 0, 0, 0, 0, 0x01, 0xa0]),
  ]); // 64B

  const di: number[] = [];
  for (let i = 0; i < 16; i++) di.push(data.readUInt32BE(i * 4)); // BE32 切词
  for (let i = 0; i < 112; i++) {
    const d1 = di[i + 1]!;
    const d14 = di[i + 14]!;
    const s1 = (rol32(d1, 14) ^ rol32(d1, 25) ^ (d1 >>> 3)) >>> 0;
    const s2 = (rol32(d14, 13) ^ rol32(d14, 15) ^ (d14 >>> 10)) >>> 0;
    di.push((di[i]! + di[i + 9]! + s1 + s2) >>> 0);
  }

  const [rounds, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10] = CHOSEN[ivV0]!;
  const d = [...init];
  for (let i = 0; i < rounds; i++) {
    const n1 = (((d[c3]! ^ d[c4]!) & d[c1]!) ^ d[c3]!) >>> 0;
    const n2 = (rol32(d[c1]!, 26) ^ rol32(d[c1]!, 21) ^ rol32(d[c1]!, 7)) >>> 0;
    const n4 = (di[(ivV1 + i) & 127]! + n1 + n2 + tt[(ivV1 + i) & 63]! + d[c5]!) >>> 0;
    const n5 = (rol32(d[c2]!, 30) ^ rol32(d[c2]!, 19) ^ rol32(d[c2]!, 10)) >>> 0;
    const n6 = ((d[c2]! & d[c6]!) | ((d[c2]! | d[c6]!) & d[c7]!)) >>> 0;
    const oldC9 = d[c9]!;
    // d 整体循环右移一格
    const last = d.pop()!;
    d.unshift(last);
    const n7 = (n5 + n6) >>> 0; // 规格未显式定义 n7；= n5+n6（SHA-256 T2，oracle 对拍确认）
    d[c10] = (n7 + n4) >>> 0;
    d[c8] = (oldC9 + n4) >>> 0;
  }

  const ret = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) ret.writeUInt32BE((d[i]! + init[i]!) >>> 0, i * 4);
  for (let i = 0; i < 16; i++) ret[i] ^= ret[i + 16]!; // ret[0:16] ^= ret[16:32]
  const sum = sumMd5(ret.subarray(0, 16));
  return Buffer.concat([ret.subarray(0, 16), le32(sum)]); // 20B
}

// MD5 标准步进移位表（规格 §3.6.1 branch2）
const MD5_V3_SHIFTS = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21],
];

/** branch 2：MD5 变体 md5sum_v3（规格 §3.6.1）；返回 20B */
export function branch2(
  iv: number,
  khronos: number,
  querySm3: Uint8Array,
  bodyMd5: Uint8Array,
  tsBytes: Uint8Array,
): Uint8Array {
  const n0 = (iv & 13) * 86; // Python 优先级语义：iv & (15-2)
  const ivV0p = ((n0 >> 15) & 0xff) + ((n0 >> 8) & 0xff); // 0..4，重新计算

  const n1 = B2_T001[ivV0p]!;
  const cV1 = (n1 + khronos + 1) & 0xff;
  const cV2 = (n1 + khronos) >>> 0;

  const shift = (cV2 + 5) & 7;
  const pad8 = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    const v = BRANCH2_PAD_SEED8[i]! | (BRANCH2_PAD_SEED8[i]! << 8);
    pad8[i] = (v >> shift) & 0xff;
  }

  const data = Buffer.concat([
    Buffer.from(querySm3),
    Buffer.from(bodyMd5),
    Buffer.from(tsBytes),
    pad8,
    Buffer.from([0xa0, 0x01, 0x00, 0x00]),
  ]); // 64B

  const orders = B2ORDERS.subarray(ivV0p << 6, (ivV0p << 6) + 64);
  const out16 = md5sumV3(data, cV2, orders, cV1);
  const sum = sumMd5(out16);
  return Buffer.concat([out16, le32(sum)]); // 20B
}

/** MD5 式压缩（4 组×16 轮；消息字下标按 orders，轮常数 sv，规格 §3.6.1） */
function md5sumV3(msg: Uint8Array, cV2: number, orders: Uint8Array, cV1: number): Uint8Array {
  const sv = SV2.map((x) => ror32(x, cV1));
  const count = cV2 & 0xff;
  const start = B2_START4.map((x) => ror32(x, count));
  const endCount = (cV2 + 6) & 0xff;
  const end = B2_END4.map((x) => ror32(x, endCount));

  const m: number[] = [];
  for (let i = 0; i < 16; i++) m.push(readU32LE(msg, i * 4)); // LE32 切词

  let a = start[0]!;
  let b = start[1]!;
  let c = start[2]!;
  let dd = start[3]!;
  for (let i = 0; i < 64; i++) {
    const group = i >> 4;
    const f =
      group === 0
        ? ((b & c) | (~b & dd)) >>> 0
        : group === 1
          ? ((b & dd) | (c & ~dd)) >>> 0
          : group === 2
            ? (b ^ c ^ dd) >>> 0
            : (c ^ (b | ~dd)) >>> 0;
    const s = MD5_V3_SHIFTS[group]![i & 3]!;
    const nb = (b + rol32((a + f + m[orders[i]!]! + sv[i]!) >>> 0, s)) >>> 0;
    a = dd;
    dd = c;
    c = b;
    b = nb;
  }

  const out = Buffer.alloc(16);
  const fin = [a, b, c, dd];
  for (let j = 0; j < 4; j++) {
    out.writeUInt32LE((((start[j]! + fin[j]!) >>> 0) ^ end[j]!) >>> 0, j * 4);
  }
  return out;
}

/** hashF13 主入口：分支 0/2 实算；branch 1 抛错（规格 §3.6.1 裁决：调用方抖 _rticket 规避） */
export function hashF13(querySm3: Uint8Array, bodyMd5: Uint8Array, khronos: number): Uint8Array {
  assertU32(khronos, 'khronos');
  const info = branchInfoOf(querySm3, bodyMd5, khronos);
  const tsBytes = le32(khronos);
  if (info.branch === 0) return branch0(info.ivV0, khronos, querySm3, bodyMd5, tsBytes);
  if (info.branch === 2) return branch2(info.iv, khronos, querySm3, bodyMd5, tsBytes);
  throw new MedusaBranch1Error(khronos);
}

/** branch 1：服务端不接受的分支（实测拒绝码 110001）——不实现，由调用方换 query（规格 §3.6.1/§6.2） */
export class MedusaBranch1Error extends Error {
  readonly khronos: number;
  constructor(khronos: number) {
    super(`hashF13 branch 1（khronos=${khronos}）：服务端拒绝该分支，调用方应抖动 _rticket 重签（规格 §6.2）`);
    this.name = 'MedusaBranch1Error';
    this.khronos = khronos;
  }
}

// ===== xmxor 混淆（规格 §3.6.3）=====

/** 循环左移 3 位专用函数（非半字节交换） */
// rotl8 复用 util（rotl8(v,3)）

export function xmxor(data: Uint8Array, key: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(len);
  // pass1：倒序写入
  for (let i = 0; i < len; i++) {
    const p = (i * 4) & 28;
    const d0 = key[p]!;
    const d1 = key[p + 1]!;
    let v = (nibSwap8(data[i]!) + d0) & 0xff;
    v = ((~v & 0xff) ^ d1) & 0xff;
    v = rotl8(v & 0xff, 3);
    v = (v + d1) & 0xff;
    v = (v ^ d0) & 0xff;
    out[len - 1 - i] = (~v & 0xff) & 0xff;
  }
  // 尾部修正（独立循环）
  const last = (out[len - 1]! ^ out[len - 2]!) & 0xff;
  const first0 = out[0]!;
  out[0] = ((~last & 0xff) + out[0]!) & 0xff;
  out[1] = ((out[0]! ^ out[len - 1]! ^ 254) + out[1]!) & 0xff;
  out[2] = (out[2]! + (((last - first0) ^ rotl8(out[1]!, 3)) ^ 2)) & 0xff;
  for (let i = 0; i <= len - 5; i++) {
    const t = (rotl8(out[i + 2]!, 3) ^ out[i + 1]! ^ (i + 3)) & 0xff;
    out[i + 3] = ((~t & 0xff) + out[i + 3]!) & 0xff;
  }
  out[len - 1] = (out[len - 1]! ^ out[len - 2]!) & 0xff;
  let sumTail = 0;
  for (let i = 1; i < len; i++) sumTail += out[i]!;
  out[0] = (((out[0]! ^ out[1]!) & 0xff) + sumTail) & 0xff;
  return out;
}

// ===== keyHash（规格 §3.6.4）=====

export function keyHash(signKey: Uint8Array, rand: number): { hash32: Uint8Array; seed4: Uint8Array } {
  assertU32(rand, 'rand');
  const hash32 = sm3(Buffer.concat([Buffer.from(signKey), le32(rand), Buffer.from(signKey)])); // 68B 输入
  const d1 = (rand >> 16) & 0xff;
  let d2 = (((d1 << 11) | (rand >>> 24)) ^ (d1 >> 5) ^ d1) >>> 0;
  d2 = ~d2 >>> 0;
  return { hash32, seed4: le32(d2) };
}

// ===== AesV3（规格 §3.6.5）=====

function xtime(x: number): number {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

export class AesV3 {
  private readonly s: Uint8Array; // 256B 段
  private readonly con2: readonly number[];
  private readonly order: readonly number[];
  private readonly exp: Uint8Array; // 48B 扩展密钥

  constructor(key16: Uint8Array, khronos: number) {
    if (key16.length !== 16) throw new RangeError(`AesV3 key 必须 16 字节，收到 ${key16.length}`);
    const ws = khronos & 3;
    this.s = SBOX1024.subarray(ws * 256, (ws + 1) * 256);
    this.con2 = AES_V3_CON2[ws]!;
    this.order = AES_V3_ORDERS[ws]!;

    // 密钥扩展：mk = (LE32(init)×4) ^ key16；exp = mk || 32×0；12 组 4 字节
    const init = AES_V3_INIT[ws]!;
    const initBytes = le32(init);
    const mk = Buffer.alloc(48);
    for (let i = 0; i < 16; i++) mk[i] = initBytes[i % 4]! ^ key16[i]!;
    this.exp = mk;

    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const at = 4 * (i - 1);
      let a = this.exp[at]!;
      let b = this.exp[at + 1]!;
      let c = this.exp[at + 2]!;
      let d = this.exp[at + 3]!;
      if (i % 4 === 0) {
        const t = ((init >>> (rounds & 24)) ^ this.s[b]!) & 0xff;
        b = this.s[c]!;
        c = this.s[d]!;
        d = this.s[a]!;
        a = t;
      }
      rounds += 2;
      this.exp[at + 4] = a ^ this.exp[at - 12]!;
      this.exp[at + 5] = b ^ this.exp[at - 11]!;
      this.exp[at + 6] = c ^ this.exp[at - 10]!;
      this.exp[at + 7] = d ^ this.exp[at - 9]!;
    }
  }

  // m 为 16B 行主序（m[i*4+j]）；word i = exp[4i..4i+4)
  private arkC(m: Uint8Array, w0: number) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) m[i * 4 + j] ^= this.exp[w0 + i * 4 + this.con2[j]!]!;
    }
  }

  private ark(m: Uint8Array, w0: number) {
    for (let k = 0; k < 16; k++) m[k] ^= this.exp[w0 + k]!;
  }

  private sub(m: Uint8Array) {
    for (let k = 0; k < 16; k++) m[k] = this.s[m[k]!]!;
    // 行按 con2 重排：newRow[i] = row[con2[i]]
    const cp = Uint8Array.from(m);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) m[i * 4 + j] = cp[this.con2[i]! * 4 + j]!;
    }
  }

  private shift(m: Uint8Array) {
    // 摊平后按 order 重排：m'[k] = m[order[k]]
    const cp = Uint8Array.from(m);
    for (let k = 0; k < 16; k++) m[k] = cp[this.order[k]!]!;
  }

  private shiftCon(m: Uint8Array) {
    // 行内按 con2 取列重排：s[i] = [s[i][c0], s[i][c1], s[i][c2], s[i][c3]]
    const cp = Uint8Array.from(m);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) m[i * 4 + j] = cp[i * 4 + this.con2[j]!]!;
    }
  }

  private mixColumns(m: Uint8Array) {
    // 标准 AES mixColumns（列 = m[0..3][j]）
    for (let j = 0; j < 4; j++) {
      const a0 = m[j]!;
      const a1 = m[4 + j]!;
      const a2 = m[8 + j]!;
      const a3 = m[12 + j]!;
      m[j] = (xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3) & 0xff;
      m[4 + j] = (a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3) & 0xff;
      m[8 + j] = (a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3)) & 0xff;
      m[12 + j] = ((xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3)) & 0xff;
    }
  }

  /** 16B 块加密：2.5 轮非标准 AES（规格 §3.6.5） */
  encryptBlock(pt: Uint8Array): Uint8Array {
    const m = Uint8Array.from(pt);
    this.arkC(m, 0); // keys[0:4]
    for (let r = 1; r <= 2; r++) {
      this.sub(m);
      this.shift(m);
      if (r === 1) {
        this.shiftCon(m);
        this.mixColumns(m);
      }
      this.arkC(m, 16 * r); // keys[4r..4r+4]（词）= 字节偏移 16r
    }
    this.ark(m, 16); // keys[4:8] 直接 XOR（不换列）
    return m;
  }

  /** sumData 位采样（32B）：pt[i] 从 data[i*8..i*8+8] 每字节采 1 位；pt[31]=1；越界读 0 */
  private sumData(data: Uint8Array): Uint8Array {
    const key = new Uint8Array(32);
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      const b0 = data[at] ?? 0;
      const b1 = data[at + 1] ?? 0;
      const b2 = data[at + 2] ?? 0;
      const b3 = data[at + 3] ?? 0;
      const b4 = data[at + 4] ?? 0;
      const b5 = data[at + 5] ?? 0;
      const b6 = data[at + 6] ?? 0;
      const b7 = data[at + 7] ?? 0;
      const n =
        (((b0 >> 4) & 2) |
          (b1 & 64) |
          ((b2 >> 2) & 1) |
          ((b3 << 3) & 128) |
          ((b4 >> 1) & 4) |
          ((b5 << 3) & 16) |
          ((b6 << 5) & 32) |
          ((b7 >> 4) & 8)) &
        0xff;
      key[i] = n;
    }
    key[31] = 1;
    return key;
  }

  /** mixColumnsInto：按 key[i] 改写 data 的 8 个特定位（越界写忽略，规格 §3.6.5） */
  private mixColumnsInto(data: Uint8Array, key: Uint8Array) {
    for (let i = 0; i < 31; i++) {
      const k = key[i]!;
      const at = i * 8;
      const put = (idx: number, v: number) => {
        if (idx >= 0 && idx < data.length) data[idx] = v & 0xff;
      };
      put(at + 0, (data[at + 0]! & 0xdf) | ((k << 4) & 32));
      put(at + 1, (data[at + 1]! & 0xbf) | (k & 64));
      put(at + 2, (data[at + 2]! & 0xfb) | ((k << 2) & 4));
      put(at + 3, (data[at + 3]! & 0xef) | ((k >> 3) & 16));
      put(at + 4, (data[at + 4]! & 0xf7) | ((k + k) & 8));
      put(at + 5, (data[at + 5]! & 0xfd) | ((k >> 3) & 2));
      put(at + 6, (data[at + 6]! & 0xfe) | ((k >> 5) & 1));
      put(at + 7, (data[at + 7]! & 0x7f) | ((k << 4) & 128));
    }
  }

  /** 输出 = key32 末 1 字节 || 变换后的 data */
  encrypt(data: Uint8Array, iv: Uint8Array): Uint8Array {
    const pt = this.sumData(data);
    const blocks: Uint8Array[] = [];
    // 显式宽类型：encryptBlock 返回的视图底层是 ArrayBufferLike（Buffer.concat/subarray），与 from(iv) 的窄类型不同源
    let previous: Uint8Array = Uint8Array.from(iv);
    for (let off = 0; off < pt.length; off += 16) {
      const x = new Uint8Array(16);
      for (let i = 0; i < 16; i++) x[i] = pt[off + i]! ^ previous[i]!;
      const blk = this.encryptBlock(x);
      blocks.push(blk);
      previous = blk;
    }
    const key32 = Buffer.concat(blocks);
    const dataCopy = Uint8Array.from(data);
    this.mixColumnsInto(dataCopy, key32);
    return Buffer.concat([key32.subarray(31, 32), Buffer.from(dataCopy)]);
  }
}

// ===== protobuf 消息（规格 §3.6.2）=====

export interface MedusaEnvOptions {
  launchTime: number; // env f1：100..120
  pid: number; // env f7：10001..12000
  deviceTs: number; // device f25-28 采样（默认进程启动毫秒）
  reportSecond: number; // env f13.1 当前秒
}

function encodeDeviceMessage(deviceId: string, secDeviceToken: string, o: MedusaEnvOptions): Buffer {
  const parts: Buffer[] = [];
  parts.push(pbZigzagField(1, 1));
  parts.push(pbZigzagField(2, 2));
  parts.push(pbString(3, MEDUSA_AID_STR));
  parts.push(pbString(4, deviceId));
  if (secDeviceToken !== '') parts.push(pbString(5, secDeviceToken));
  parts.push(pbString(6, DEVICE_NO_PERM));
  parts.push(pbZigzagField(7, DEVICE_BATTERY));
  parts.push(pbZigzagField(8, DEVICE_BATTERY));
  parts.push(pbZigzagField(9, DEVICE_BATTERY_HEALTH));
  parts.push(pbZigzagField(10, DEVICE_BATTERY));
  parts.push(pbString(11, DEVICE_NOT_SET));
  parts.push(pbString(12, DEVICE_TZ));
  parts.push(pbString(13, DEVICE_LANG));
  parts.push(pbZigzagField(14, DEVICE_CPU));
  // f16-21 float：[P] 路线全 0.0（编码保留，规格 §9.6）
  for (let f = 16; f <= 21; f++) parts.push(pbFloatField(f, 0.0));
  parts.push(pbString(22, DEVICE_OS_VERSION));
  parts.push(pbZigzagField(23, DEVICE_BRIGHTNESS));
  parts.push(pbZigzagField(24, DEVICE_VOLUME));
  parts.push(pbZigzagField(25, o.deviceTs));
  parts.push(pbZigzagField(26, o.deviceTs));
  parts.push(pbZigzagField(27, o.deviceTs));
  parts.push(pbZigzagField(28, o.deviceTs)); // [P] 第 4 个不加 2（+2 是 [T] 采样细节，规格 §3.6.2 该行表述含糊，跟随 [P] 路线）
  parts.push(pbZigzagField(29, DEVICE_USB));
  parts.push(pbString(30, DEVICE_MODEL));
  parts.push(pbString(31, DEVICE_BOARD));
  parts.push(pbString(32, DEVICE_MODEL));
  parts.push(pbString(33, DEVICE_MODEL));
  parts.push(pbString(34, DEVICE_MANUFACTURER));
  parts.push(pbString(35, DEVICE_BRAND));
  parts.push(pbString(36, DEVICE_HARDWARE));
  parts.push(pbZigzagField(38, DEVICE_UNKNOWN38));
  return Buffer.concat(parts);
}

function encodeEnvMessage(deviceId: string, secDeviceToken: string, versionName: string, o: MedusaEnvOptions): Buffer {
  const report = Buffer.concat([
    pbZigzagField(1, o.reportSecond),
    pbZigzagField(2, ENV_REPORT_STATE),
    pbZigzagField(4, ENV_REPORT_CODE),
  ]);
  return Buffer.concat([
    pbZigzagField(1, o.launchTime),
    pbZigzagField(2, ENV_UNKNOWN2),
    pbZigzagField(3, ENV_UNKNOWN3),
    pbZigzagField(5, ENV_UNKNOWN5),
    pbString(6, ENV_SDK_BUGFIX),
    pbZigzagField(7, o.pid),
    pbBytes(12, encodeDeviceMessage(deviceId, secDeviceToken, o)),
    pbBytes(13, report),
    pbString(14, versionName),
  ]);
}

export function buildMedusaProto(params: {
  query: string;
  bodyMd5: Uint8Array; // 16B（无 body 为 16×0）
  querySm3: Uint8Array; // 32B
  qbts: Uint8Array; // hashF13 输出 20B
  deviceId: string;
  secDeviceToken: string;
  khronos: number;
  protoRand: number;
  env: MedusaEnvOptions;
}): Uint8Array {
  const versionName = MEDUSA_VERSION_NAME;
  const queryBodyHash = sm3(Buffer.concat([utf8(params.query), Buffer.from(params.bodyMd5), utf8('none')]));
  const nested15 = Buffer.concat([
    pbZigzagField(1, MEDUSA_F15.signCount),
    pbZigzagField(2, MEDUSA_F15.unknown2),
    pbZigzagField(3, MEDUSA_F15.unknown3),
    pbZigzagField(5, MEDUSA_F15.unknown5),
  ]);
  return Buffer.concat([
    pbBytes(1, MEDUSA_MAGIC16),
    pbZigzagField(2, 3),
    pbZigzagField(3, params.protoRand),
    pbString(4, MEDUSA_AID_STR),
    pbString(5, params.deviceId),
    pbString(6, MEDUSA_LICENSE_STR),
    pbString(7, versionName),
    pbString(8, MEDUSA_SDK_STR),
    pbZigzagField(9, MEDUSA_SDK_NUM),
    pbBytes(10, MEDUSA_MAGIC8), // LE64(320)
    pbZigzagField(12, params.khronos),
    pbBytes(13, params.qbts),
    pbBytes(14, params.querySm3.subarray(0, 6)),
    pbBytes(15, nested15),
    params.secDeviceToken === '' ? Buffer.alloc(0) : pbString(16, params.secDeviceToken),
    pbZigzagField(17, params.khronos),
    // f18 lanusk_hash：恒空省略
    pbBytes(19, queryBodyHash), // SM3(query || bodyMd5raw || "none")
    pbString(20, MEDUSA_PSK),
    pbZigzagField(21, MEDUSA_CALL_TYPE),
    pbBytes(23, encodeEnvMessage(params.deviceId, params.secDeviceToken, versionName, params.env)),
    pbString(24, MEDUSA_FIXED_JSON),
    // f26 original：恒缺省略
  ]);
}

// ===== 组装与输出（规格 §3.6.6）=====

export interface MedusaInput {
  query: string;
  body: string | null;
  deviceId: string;
  khronos: number;
  secDeviceToken: string;
  protoRand: number;
  rndKey: number;
  rndXm: number;
  launchTime: number;
  pid: number;
  /** device f25-28 采样（默认进程启动毫秒） */
  deviceTs?: number;
  /** env f13.1 当前秒（默认 khronos） */
  reportSecond?: number;
}

export function medusa(input: MedusaInput): string {
  const khronos = assertU32(input.khronos, 'khronos');
  const querySm3 = sm3(utf8(input.query));
  const bodyMd5 = input.body != null && input.body !== '' ? md5Raw(utf8(input.body)) : Buffer.alloc(16);
  const qbts = hashF13(querySm3, bodyMd5, khronos); // branch 1 → MedusaBranch1Error

  const env: MedusaEnvOptions = {
    launchTime: input.launchTime,
    pid: input.pid,
    deviceTs: input.deviceTs ?? processStartMs,
    reportSecond: input.reportSecond ?? khronos,
  };
  const msg = buildMedusaProto({
    query: input.query,
    bodyMd5,
    querySm3,
    qbts,
    deviceId: input.deviceId,
    secDeviceToken: input.secDeviceToken,
    khronos,
    protoRand: input.protoRand,
    env,
  });

  const { hash32, seed4 } = keyHash(MEDUSA_SIGN_KEY, input.rndKey);
  let mixed = Buffer.concat([MEDUSA_MAGIC8, Buffer.from(xmxor(msg, hash32))]); // LE64(320) 前缀
  mixed = Buffer.from(mixed).reverse(); // 整体逆序
  for (let i = 0; i < mixed.length; i++) mixed[i] ^= seed4[(~i) & 3]!; // 按位取反下标

  const check = (((querySm3[0]! & 63) << 14) | 0x18000001 | ((qbts[0]! & 63) << 8)) >>> 0;
  const packed = Buffer.concat([
    Buffer.from([0x35]),
    le32(input.rndXm),
    le32(check),
    mixed,
    Buffer.from([(input.rndKey >>> 16) & 0xff, (input.rndKey >>> 24) & 0xff]),
  ]);

  const enc = new AesV3(MEDUSA_AES_KEY, khronos).encrypt(packed, MEDUSA_AES_IV);

  // prefix[i..i+4) = LE32(u32LE(ver, i) ^ khronos)，i = 0,4,8,12,16
  const prefix = Buffer.alloc(20);
  for (let i = 0; i < 20; i += 4) {
    prefix.writeUInt32LE((readU32LE(MEDUSA_VER, i) ^ khronos) >>> 0, i);
  }
  return Buffer.concat([
    prefix,
    Buffer.from([input.rndKey & 0xff, (input.rndKey >>> 8) & 0xff]),
    Buffer.from([0x00, 0x01]),
    enc,
  ]).toString('base64');
}

// 进程启动毫秒（device f25-28 采样，[P] 路线，规格 §9.6）
const processStartMs = Date.now();
