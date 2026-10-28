import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { decryptEnvelope } from './protocol';

/**
 * 黄果 Android 平台 API 客户端（自 huangguo/android/gateway/main.go 移植）。
 * 会话策略与 Go 版一致：进程生命周期自注册游客账号一次，token 内存复用；
 * 登录按 IP 限频（code 4007）退避 5 分钟，token 真失效（5009）强制重登一次。
 * HUANGGUO_TOKEN 环境变量可注入外部取号的 token（限频时的运维逃生口）。
 */

export const HUANGGUO_API_BASE = process.env.HUANGGUO_API || 'https://d2jgz4wrcczusu.cloudfront.net';
const ANDROID_API = HUANGGUO_API_BASE;

/** UA 为字面 URL-encode 后的设备头（Go 版 url.QueryEscape 产物，逐字节一致） */
const ANDROID_UA = encodeURIComponent(
  'DevID=hgdjbgwweb00000000000000000000;DevType=NX709S:32:id=SKQ1.220502.001;SysType=android;Ver=1.0.8;BuildID=dark.yyDdu.wTTdI;DeviceBrand=nubia;SystemName=Android;SystemVersion=12;device_model=NX709S'
);

/** token 落盘（默认 os.tmpdir）：上游登录按 IP 限频（4007），进程重启/热重载不得重登 */
const TOKEN_FILE = process.env.HUANGGUO_TOKEN_FILE || join(tmpdir(), 'freetv-huangguo-token.cache');

let cachedToken = process.env.HUANGGUO_TOKEN || '';

/** 惰性读盘：内存无 token 时先看落盘（热重载后模块重建，盘上 token 仍可救） */
function restoreTokenFromFile(): string {
  if (cachedToken) return cachedToken;
  try {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved.length > 50) {
      cachedToken = saved;
      return saved;
    }
  } catch {
    /* 读不了就当没有，走登录 */
  }
  return '';
}
let loginBackoffUntil = 0;
let loginInFlight: Promise<string> | null = null;

function randHex(n: number): string {
  return randomBytes(n).toString('hex');
}

async function loginGuest(): Promise<string> {
  const body = JSON.stringify({
    devID: 'hgdjb' + randHex(20),
    qrCnt: '',
    devType: 'NX709S:32:id=SKQ1.220502.001',
    sysType: 'android',
    ver: '1.0.8',
    buildID: 'dark.yyDdu.wTTdI',
    devToken: 'hgweb' + randHex(24),
    cutInfos: '{"dc":"hgwebcom"}',
  });
  const res = await fetchUpstream(`${ANDROID_API}/api/app/mine/login`, {
    timeoutMs: 15000,
    method: 'POST',
    headers: { 'User-Agent': ANDROID_UA, 'Content-Type': 'application/json' },
    body,
  });
  const env = (await res.json()) as { code?: number; msg?: string; data?: string };
  if (env.code !== 200 || !env.data) {
    if (env.code === 4007) loginBackoffUntil = Date.now() + 5 * 60 * 1000;
    throw new Error(`登录失败 code=${env.code} ${env.msg || ''}`);
  }
  const token = (JSON.parse(decryptEnvelope(env.data).toString('utf8')) as { token?: string }).token;
  if (!token) throw new Error('登录响应无 token');
  return token;
}

async function guestToken(force: boolean): Promise<string> {
  if (Date.now() < loginBackoffUntil) throw new Error('登录限频退避中（约 5 分钟），可通过 HUANGGUO_TOKEN 注入 token');
  if (!force) {
    const restored = restoreTokenFromFile();
    if (restored) return restored;
  }
  if (!loginInFlight) {
    loginInFlight = loginGuest()
      .then((tok) => {
        cachedToken = tok;
        try {
          writeFileSync(TOKEN_FILE, tok, { mode: 0o600 });
        } catch {
          /* 落盘失败不影响会话，仅下次进程需重登 */
        }
        return tok;
      })
      .finally(() => {
        loginInFlight = null;
      });
  }
  return loginInFlight;
}

interface Envelope {
  code?: number;
  msg?: string;
  data?: unknown;
}

/** GET → 解密信封后的明文 JSON 对象；token 失效自动重登一次 */
export async function andGet(path: string, force = false): Promise<Record<string, unknown>> {
  const tok = await guestToken(force);
  const res = await fetchUpstream(`${ANDROID_API}${path}`, {
    timeoutMs: 15000,
    headers: { 'User-Agent': ANDROID_UA, authorization: tok },
  });
  const raw = await res.text();
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    throw new Error(`上游响应非 JSON（${path}）`);
  }
  if (env.code !== 200) {
    if (raw.includes('"code":5009') && !force) return andGet(path, true);
    throw new Error(`接口失败 ${path} code=${env.code} ${env.msg || ''}`);
  }
  if (typeof env.data === 'string') {
    return JSON.parse(decryptEnvelope(env.data).toString('utf8')) as Record<string, unknown>;
  }
  if (env.data && typeof env.data === 'object') return env.data as Record<string, unknown>;
  throw new Error(`接口 ${path} data 类型异常`);
}

/** 同 andGet 但保留原始字节（m3u8 playlist 透传用；playlist 非信封加密） */
export async function andGetRaw(path: string, force = false): Promise<Buffer> {
  const tok = await guestToken(force);
  const res = await fetchUpstream(`${ANDROID_API}${path}`, {
    timeoutMs: 15000,
    headers: { 'User-Agent': ANDROID_UA, authorization: tok },
  });
  return Buffer.from(await res.arrayBuffer());
}

// —— 详情（10 分钟缓存，与 Go 版一致） ——

export interface HgChapter {
  ep: number;
  title: string;
  mediaTime: number;
  /** vid/h5/m3u8 下的相对路径 token；仅服务端 m3u8 路由使用，不下发前端 */
  token: string;
}

export interface HgDetail {
  title: string;
  summary: string;
  cover: string;
  totalEp: number;
  updateEp: number;
  preview: string;
  chapters: HgChapter[];
}

function toInt(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export async function getDetail(id: string): Promise<HgDetail> {
  const cacheKey = `huangguo:detail:${id}`;
  const cached = getCache<HgDetail>(cacheKey);
  if (cached) return cached;
  const m = await andGet(`/api/app/playlet/detail/${id}`);
  const chapters: HgChapter[] = [];
  if (Array.isArray(m['chapters'])) {
    for (const c of m['chapters']) {
      if (!c || typeof c !== 'object') continue;
      const ch = c as Record<string, unknown>;
      const token = toStr(ch['videoUrl']);
      if (!token) continue; // 极少数字节损坏/下架集
      chapters.push({
        ep: toInt(ch['currentEpisode']),
        title: toStr(ch['title']),
        mediaTime: toInt(ch['mediaTime']),
        token,
      });
    }
  }
  const detail: HgDetail = {
    title: toStr(m['title']),
    summary: toStr(m['summary']),
    cover: toStr(m['cover']),
    totalEp: toInt(m['totalEpisode']),
    updateEp: toInt(m['updateEpisode']),
    preview: toStr(m['preview']),
    chapters,
  };
  setCache(cacheKey, detail, 10 * 60 * 1000);
  return detail;
}
