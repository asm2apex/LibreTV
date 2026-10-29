// HTTP 基础设施：Python quote 语义的 query 编码、超时/重试 fetch、全局节流。
// 规格：docs/protocol/02-api-and-decryption.md §9（请求卫生）。
// query 编码陷阱【已验证 app-source.js:234-237】：签名所用的 query 串必须与
// 服务端收到的一致——`!'()*` 也要 %XX 转义，否则签名校验失败。

export const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
// 红果 App 语境（规格 01 §1 红果列）
export const UA_APP_HONGGUO =
  'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

/** Python urllib.parse.quote(s, safe='') 语义：仅 A-Za-z0-9-_.~ 不转义，%XX 大写。 */
export function pythonQuote(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ||
      c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e
    ) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** 组装 query：字段按插入序拼接（规格 02 §9.2），值经 pythonQuote。 */
export function buildQuery(params: Array<[string, string | number]>): string {
  return params.map(([k, v]) => `${k}=${pythonQuote(String(v))}`).join('&');
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  method?: string;
  body?: string;
}

async function fetchOnce(url: string, opts: FetchOptions): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: ctl.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** fetch + 有限重试（网络错误与 5xx 重试；4xx 不重试）。 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchOnce(url, opts);
      if (res.status >= 500 && i < retries) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(opts.retryDelayMs ?? 500 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 同进程串行节流：任意两次通过 acquire 的上游请求间隔 ≥ minIntervalMs（规格 02 §8.4）。 */
export class Throttle {
  private chain: Promise<void> = Promise.resolve();
  private last = 0;
  private readonly minIntervalMs: number;
  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }

  acquire(): Promise<void> {
    const run = this.chain.then(async () => {
      const now = Date.now();
      const wait = this.last + this.minIntervalMs - now;
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

/** API/直链 URL 清洗：\/、\u0026、&amp; 等转义（规格 02 §1.3）。 */
export function cleanUrl(u: string): string {
  return u
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}
