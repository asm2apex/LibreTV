// spade_a → content key 派生（红果 CENC 内容密钥）。
// 规格：docs/protocol/02-api-and-decryption.md §4（唯一实现依据）。
// 纯字节变换（XOR + POPCOUNT + 位置相关），逆向自 libttmplayer.so FUN_001c4550 的
// ver1 路径；无 KEK、无 AES、无网络。ver2（app_v2/web_v2，AES-GCM）生态内无公开
// 实现，本模块显式拒绝——出现即按不可播放处理，不要静默降级。
// 验收基准：spade.js 内置 5 组 libttmplayer hook 真值（见 spade.test.ts）。

const KEY_RE = /^[0-9a-f]{32}$/;

export class SpadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpadeError';
  }
}

function popcount(v: number): number {
  let c = 0;
  while (v > 0) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

// base64 容错解码：上游出现过 URL-safe 变体与缺 padding 的样本（tvbox:1170-1176）。
function decodeBase64Loose(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  if (buf.length === 0) throw new SpadeError('spade: base64 解码为空');
  return new Uint8Array(buf);
}

// S6 判别（只读不改数据）：尾部 type 串按 NUL 截断后以 app_v2/web_v2 开头 → ver2。
function isV2(raw: Uint8Array, L: number, n: number): boolean {
  if (n < 1 || L - n - 2 < 0) return false;
  const b16 = raw[L - n - 2]!;
  const b14 = raw[L - n - 1]!;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    out[i] = (b14 ^ b16 ^ raw[L - n + i]!) & 0xff;
  }
  const s = out.toString('latin1').split('\0')[0]!;
  return s.startsWith('app_v2') || s.startsWith('web_v2');
}

// S7 ver1 字节变换。flag ∈ {0,1} 互为镜像（±0x15+pc 方向相反）。
// 严格按规格伪代码的赋值顺序翻译：奇数步里 cur16 先被改写再参与本步 XOR，
// 寄存器交替语义依赖这个顺序，"优化"成先算后交换会算错。
function transform(dest: Uint8Array, u: number, flag: number): void {
  let cur14 = 0x55;
  let cur16 = 0xfa;
  for (let i = 0; i < u; i++) {
    const b6 = dest[i]!;
    const pc = popcount(i);
    let b3 = b6;
    let b7 = cur14;
    if (i % 2 === 1) {
      b3 = cur16;
      b7 = b6;
      cur16 = cur14;
    }
    const delta = flag === 0 ? -0x15 - pc : 0x15 + pc;
    dest[i] = (delta + (cur16 ^ b6)) & 0xff;
    cur14 = b7;
    cur16 = b3;
  }
}

// S8 切 key：dest[0] 是 hex 字符，其数值 = key 段之后的尾部垃圾字节数。
function sliceKey(dest: Uint8Array, u: number): string {
  const c0 = dest[0]!;
  let h: number;
  if (c0 >= 0x30 && c0 <= 0x39) h = c0 - 0x30;
  else if (c0 >= 0x61 && c0 <= 0x7a) h = c0 - 0x57;
  else throw new SpadeError('spade: dest[0] 非 hex 字符');
  const end = u - h;
  if (end < 2) throw new SpadeError('spade: key 段过短');
  return Buffer.from(dest.subarray(1, end)).toString('latin1');
}

/**
 * 从 spade_a（base64）派生 32 hex 字符的 CENC content key。
 * 流程：S1 长度校验 → S2-S4 计算段长 → S6 ver2 拒绝 → S7 变换（flag=0 失败再试
 * flag=1，见规格 §4.2）→ S8 切 key → ^[0-9a-f]{32}$ 校验。
 */
export function deriveContentKey(spadeA: string): string {
  const raw = decodeBase64Loose(spadeA);
  const L = raw.length;
  if (L < 3) throw new SpadeError('spade: 长度 < 3');

  const b = (raw[0]! ^ raw[1]! ^ raw[2]!) & 0xff;
  const n = b - 0x30;
  if (n < 1) throw new SpadeError('spade: type 串长度非法');

  let u = L - b + 0x2f;
  if (u < 1 || 1 + u > L) {
    // tvbox 的越界回退（tvbox:569-570）：u = L - 1
    u = L - 1;
    if (u < 1) throw new SpadeError('spade: u 越界');
  }

  if (isV2(raw, L, n)) {
    throw new SpadeError('spade: ver2（app_v2/web_v2，AES-GCM）不支持');
  }

  let lastErr: unknown = null;
  for (const flag of [0, 1]) {
    const dest = Uint8Array.from(raw.subarray(1, 1 + u));
    transform(dest, u, flag);
    try {
      const key = sliceKey(dest, u);
      if (KEY_RE.test(key)) return key;
      lastErr = new SpadeError('spade: key 非 32 位 hex');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new SpadeError('spade: 派生失败');
}
