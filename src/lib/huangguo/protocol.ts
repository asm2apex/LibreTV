import { createHash, createDecipheriv } from 'node:crypto';

/**
 * 黄果短剧 Android 平台协议层（自 huangguo/android/gateway/main.go 移植，规范同源）。
 * 信封：base64url(nonce[12] + AES-256-CBC(key,iv=derive(ifaceKey||nonce), payload+PKCS7))。
 * ifaceKey 为 APK 逆向所得固定接口盐；派生为三路 SHA-256 交错取段。
 */

const IFACE_KEY = Buffer.from('65dc07d1b7915c6b2937432b091837a7', 'utf8');

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** 与 Go deriveKeys 逐段对齐：a/l/c 三路哈希交错拼 key(32B) 与 iv(16B) */
export function deriveKeys(nonce: Buffer): { key: Buffer; iv: Buffer } {
  const r = Buffer.concat([IFACE_KEY, nonce]);
  const o = Math.floor(r.length / 2);
  const a = sha256(r).subarray(8, 24);
  const l = sha256(a, r.subarray(0, o));
  const c = sha256(r.subarray(o), a);
  const key = Buffer.concat([l.subarray(0, 8), c.subarray(8, 24), l.subarray(24, 32)]);
  const iv = Buffer.concat([c.subarray(0, 4), l.subarray(12, 20), c.subarray(28, 32)]);
  return { key, iv };
}

/** base64url 变体解码：截断首个 = 之后内容、-/_ 映射、补齐 padding */
export function b64urlDecode(s: string): Buffer {
  const cut = s.indexOf('=');
  const body = (cut >= 0 ? s.slice(0, cut) : s).trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** 解密响应信封 data 字段 → 明文 JSON 字节；结构非法/解密失败抛错 */
export function decryptEnvelope(data: string): Buffer {
  const t = b64urlDecode(data);
  if (t.length < 12 + 16) throw new Error('bad payload');
  const { key, iv } = deriveKeys(t.subarray(0, 12));
  const ct = t.subarray(12);
  // setAutoPadding(false)：update/final 吐全部块，PKCS7 由下方手动校验剥离（对齐 Go 版）
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const p = plain[plain.length - 1];
  if (p === 0 || p > 16 || p > plain.length) throw new Error('unpad fail');
  return plain.subarray(0, plain.length - p);
}

/** 封面图 CDN 前缀 XOR 去混淆：前 100 字节 XOR "2019ysapp7527" 循环 */
const IMG_KEY = Buffer.from('2019ysapp7527', 'utf8');

export function deobfuscateImage(body: Buffer): Buffer {
  const out = Buffer.from(body); // 拷贝，避免改动调用方持有的缓冲
  const n = Math.min(out.length, 100);
  for (let i = 0; i < n; i++) out[i] ^= IMG_KEY[i % IMG_KEY.length];
  return out;
}
