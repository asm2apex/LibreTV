// X-Ladon（番茄语境）与 X-Helios（红果语境）——同一分组密码（规格 §3.4【已验证】）。
// 明文 = "{khronos}-{license_id}-{appid}"（语境固定三元组）；PKCS7（块 16，对齐补整块，规格 §9.4 建议语义）；
// 轮密钥 34 个 u64（队列 push/shift + T 表写回，第 34 次写入不被使用，§3.4.2），种子 aid 与明文 appid 是两个输入
// （番茄 [D] createLadon(ts, aid, random)：aid 只进轮密钥，明文恒 1611921764-3019；红果 helios 两者同为 8662）。
// 类 Feistel 34 轮：y = k ^ (x + rotr64(y,8)); x = y ^ rotr64(x,61)。
// 输出 base64(prefix || 密文)；番茄 ladon prefix = 4 随机字节，红果 helios prefix = LE32(rand)。
import { Buffer } from 'node:buffer';
import { md5HexLower, utf8, readU64LE, le64, rotr64, M64, pkcs7, assertU32 } from './util';
import { FANQIE_LADON, HONGGUO_HELIOS } from './constants';

/** 34 轮密钥扩展（规格 §3.4.2）：digest = md5_hex(prefix||str(keyAid))，T 表 = digest ASCII */
function expandKeys(prefix: Uint8Array, keyAid: number): bigint[] {
  const digestHex = md5HexLower(Buffer.concat([Buffer.from(prefix), utf8(String(keyAid))]));
  const buf = Buffer.alloc(280);
  Buffer.from(digestHex, 'ascii').copy(buf, 0); // T[0:32]，写入区扩到 280B

  const q: bigint[] = [readU64LE(buf, 16), readU64LE(buf, 24)]; // Q = [w2, w3]
  let L = readU64LE(buf, 0); // w0
  let R = readU64LE(buf, 8); // w1
  for (let i = 0; i < 34; i++) {
    const m = ((rotr64(R, 8) + L) & M64) ^ BigInt(i);
    q.push(m);
    L = m ^ rotr64(L, 61);
    buf.writeBigUInt64LE(L & M64, (i + 1) * 8); // 写回表
    R = q.shift()!;
  }
  const rk: bigint[] = [];
  for (let i = 0; i < 34; i++) rk.push(readU64LE(buf, i * 8)); // 偏移 0..264；272 处的第 34 次写入不用
  return rk;
}

function encryptBlock(rk: readonly bigint[], blk: Uint8Array): Buffer {
  let x = readU64LE(blk, 0);
  let y = readU64LE(blk, 8);
  for (const k of rk) {
    y = k ^ ((x + rotr64(y, 8)) & M64);
    x = y ^ rotr64(x, 61);
  }
  return Buffer.concat([le64(x), le64(y)]);
}

/** 通用实现：明文与轮密钥种子分开传；prefix 非 4 字节抛 RangeError */
export function ladonEncrypt(khronos: number, plaintext: string, keyAid: number, prefix: Uint8Array): string {
  assertU32(khronos, 'khronos');
  if (!(prefix instanceof Uint8Array) || prefix.length !== 4) {
    const len = prefix instanceof Uint8Array ? prefix.length : String(prefix);
    throw new RangeError(`ladon prefix 必须是 4 字节 Uint8Array，收到 ${len}`);
  }
  const rk = expandKeys(prefix, keyAid);
  const data = pkcs7(utf8(plaintext));
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += 16) {
    out.push(encryptBlock(rk, data.subarray(off, off + 16)));
  }
  return Buffer.concat([Buffer.from(prefix), ...out]).toString('base64');
}

/** 番茄语境 x-ladon：明文 "{ts}-1611921764-3019"；keyAid = 调用方 aid；prefix = 4 随机字节 */
export function ladon(khronos: number, keyAid: number, random: Uint8Array): string {
  return ladonEncrypt(khronos, `${khronos}-${FANQIE_LADON.licenseId}-${FANQIE_LADON.appId}`, keyAid, random);
}

/** 红果语境 x-helios：明文 "{ts}-1588093228-8662"（§3.4.1 [T:3100]）；prefix = LE32(heliosRand)（§3.4.4） */
export function helios(khronos: number, rand: number): string {
  assertU32(rand, 'heliosRand');
  const prefix = Buffer.from([rand & 0xff, (rand >>> 8) & 0xff, (rand >>> 16) & 0xff, (rand >>> 24) & 0xff]);
  return ladonEncrypt(khronos, `${khronos}-${HONGGUO_HELIOS.licenseId}-${HONGGUO_HELIOS.appId}`, HONGGUO_HELIOS.appId, prefix);
}
