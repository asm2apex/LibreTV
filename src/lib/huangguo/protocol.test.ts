import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64urlDecode, decryptEnvelope, deobfuscateImage, deriveKeys } from './protocol';

/** 黄果派生算法黄金向量：由 canonical android/gateway/main.go 的 Go 原版对拍生成 */
const GO_VECTORS: Array<{ nonce: string; key: string; iv: string }> = [
  {
    nonce: '000102030405060708090a0b',
    key: 'a7a23e6641ae10fbc0079a7243ba222f348abad81981c12e00c54e4ba41adf3c',
    iv: '3e726e7342840f4a45edad6ed9460fe3',
  },
  {
    nonce: 'deadbeefcafebabe11223344',
    key: '61c7503f1d23e53f489123d0d22c224fc27dd3f3d6eaaa609c0f3c61dc19f70d',
    iv: 'ed85a47cb8e576b2b1c2501744d4e85b',
  },
  {
    nonce: 'ffffffffffffffffffffffff',
    key: '098666cdd39e15f4f8448b276d1a20cc04402e07710329124cb0eb4c47883e8d',
    iv: 'e7053e1bdaef76876de49f9efad49414',
  },
];

describe('deriveKeys', () => {
  it('与 Go 原版逐字节一致（黄金向量）', () => {
    for (const v of GO_VECTORS) {
      const { key, iv } = deriveKeys(Buffer.from(v.nonce, 'hex'));
      expect(key.toString('hex')).toBe(v.key);
      expect(iv.toString('hex')).toBe(v.iv);
    }
  });
});

describe('b64urlDecode', () => {
  it('处理 -/_ 映射、padding 补齐与 = 后缀截断', () => {
    expect(b64urlDecode('AAEC').toString('hex')).toBe('000102');
    expect(b64urlDecode('-_8=').toString('hex')).toBe('fbff');
    expect(b64urlDecode('YWJj').toString('utf8')).toBe('abc');
  });
});

describe('decryptEnvelope', () => {
  it('自造信封解密往返（TS 加密侧 → decryptEnvelope）', () => {
    const nonce = randomBytes(12);
    const { key, iv } = deriveKeys(nonce);
    const payload = Buffer.from(JSON.stringify({ token: 'abc123', ok: true }), 'utf8');
    const pad = 16 - (payload.length % 16);
    const padded = Buffer.concat([payload, Buffer.alloc(pad, pad)]);
    const ct = createCipheriv('aes-256-cbc', key, iv).update(padded);
    const envelope = Buffer.concat([nonce, ct]).toString('base64url');
    const plain = decryptEnvelope(envelope);
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ token: 'abc123', ok: true });
  });

  it('载荷过短抛错', () => {
    expect(() => decryptEnvelope(Buffer.from('short').toString('base64'))).toThrow();
  });
});

describe('deobfuscateImage', () => {
  it('仅前 100 字节参与 XOR 且不改动入参缓冲', () => {
    const body = Buffer.alloc(150, 0x41);
    const original = Buffer.from(body);
    const out = deobfuscateImage(body);
    expect(body.equals(original)).toBe(true); // 入参未被改动
    expect(out[0]).toBe(0x41 ^ 0x32); // '2'
    expect(out[99]).toBe(0x41 ^ IMG_KEY_AT(99));
    expect(out[100]).toBe(0x41); // 100 字节之后原样
  });
});

function IMG_KEY_AT(i: number): number {
  const key = Buffer.from('2019ysapp7527', 'utf8');
  return key[i % key.length];
}
