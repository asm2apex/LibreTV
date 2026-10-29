// key_seed 加密的直链 URL 解密。规格：docs/protocol/02-api-and-decryption.md §3.4。
// 密文 = base64(main_url)；布局 [0]=0xA8 [1]=任意 [2]=0x01 [3]=0x00 [4:]=CBC 密文。
// key/iv = 双重 SHA512(key_seed || 64B 固定盐) 的前 32 字节切分。无 key_seed 时
// URL 是明文，调用方直接清洗使用（本文 decrypt 函数只处理有 key_seed 的情形）。

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

// 64 字节固定盐（tvbox:3451-3471 与 app-source.js:457-485 逐常数一致，反编译来源）
const URL_CONSTANTS = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba4' +
    '1cb2462b829ab58a196b39db57177524' +
    'f49baf7f08e8d68d26a72e37c1a95a2f' +
    '1f05a51892aef2949732b62a38aadd58',
  'hex',
);

function deriveKeyIv(keySeed: string): { key: Buffer; iv: Buffer } {
  const h1 = createHash('sha512').update(keySeed, 'utf8').digest();
  const h2 = createHash('sha512').update(Buffer.concat([h1, URL_CONSTANTS])).digest();
  return { key: h2.subarray(0, 16), iv: h2.subarray(16, 32) };
}

/** 解密被 key_seed 加密的 main_url/backup_url，返回明文 URL。格式不符抛 UrlCipherError。 */
export function decryptSpadeUrl(b64Cipher: string, keySeed: string): string {
  const raw = Buffer.from(b64Cipher, 'base64');
  if (raw.length < 20 || raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00) {
    throw new UrlCipherError('URL 密文布局不符（期望 a8 ?? 01 00）');
  }
  const cipherLen = raw.length - 4 - ((raw.length - 4) % 16); // 尾部非整块丢弃
  const { key, iv } = deriveKeyIv(keySeed);
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  const plain = d.update(raw.subarray(4, 4 + cipherLen));
  // 先去 PKCS#7（1..16）再去 \x00
  const pad = plain[plain.length - 1]!;
  let end = plain.length;
  if (pad >= 1 && pad <= 16) {
    let ok = true;
    for (let i = plain.length - pad; i < plain.length; i++) {
      if (plain[i] !== pad) {
        ok = false;
        break;
      }
    }
    if (ok) end = plain.length - pad;
  }
  const url = plain.subarray(0, end).toString('utf8').replace(/\0+$/, '');
  if (!/^https?:\/\//.test(url)) throw new UrlCipherError('解密结果不是 URL');
  return url;
}

/** 测试/对拍用：按同规格加密（仅回环验证，不进生产路径）。 */
export function encryptSpadeUrl(url: string, keySeed: string): string {
  const { key, iv } = deriveKeyIv(keySeed);
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  const pad = 16 - (Buffer.byteLength(url, 'utf8') % 16);
  const plain = Buffer.concat([Buffer.from(url, 'utf8'), Buffer.alloc(pad, pad)]);
  const cipher = c.update(plain);
  const head = Buffer.from([0xa8, 0x37, 0x01, 0x00]);
  return Buffer.concat([head, cipher]).toString('base64');
}

export class UrlCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlCipherError';
  }
}
