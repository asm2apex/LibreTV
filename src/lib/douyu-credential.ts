import crypto from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { NextResponse } from 'next/server';
import { deriveKey } from './auth';
import {
  COOKIE_RENEW_INTERVAL_MS,
  RENEW_INVALID_RETRY_BACKOFF_MS,
  RENEW_RETRY_BACKOFF_MS,
  applyDeviceIdPolicy,
  cookieString,
  loginCookieKnownExpired,
  parseCookieFields,
  shouldEscalateTempFailure,
  type DouyuScanLogin,
} from './douyu-auth';
import type { DouyuSessionStatus } from './types';

/**
 * 斗鱼登录凭证的存放：加密后放在本站的 httpOnly cookie（ftv_douyu，path 限定 /api/live）。
 * - 每个浏览器各自登录自己的账号，服务端无状态（Vercel 等平台也不需要存储）；
 * - httpOnly：页面脚本碰不到 acf_* 与 LTP0，XSS 拿不走账号；
 * - AES-256-GCM，密钥由站点密钥派生：cookie 离开本站部署就是一串废字节，被改过一个字节即整体作废；
 * - 先 deflate 再加密：acf_* 全家桶 + LTP0 接近 2KB，压一下离单 cookie 4KB 上限远一些。
 * 凭证原文永远不出现在 JSON 响应里，前端只拿得到 sessionStatus 的非敏感摘要。
 */

export const DOUYU_COOKIE = 'ftv_douyu';
export const DOUYU_COOKIE_PATH = '/api/live';
/** cookie 本身的保存期：LTP0 数月有效，续期会不断重写 */
const COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;
const KEY_PURPOSE = 'douyu-credential';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface DouyuCredential {
  v: 1;
  /** 主站登录 cookie 串（acf_* 全家桶，按字段名排序） */
  cookie: string;
  /** passport 域长期凭证，续期用；空串表示扫码时没拿到，到期只能重扫 */
  ltp0: string;
  dyDid: string;
  uid: string;
  nickname: string;
  /** 上次拿到新鲜 acf_*（扫码或续期成功）的时间，epoch ms */
  issuedAt: number;
  /** 下次应续期的时间（含失败退避），epoch ms */
  nextRenewAt: number;
  /** 续期已判定凭证失效、需重新扫码（去重用：失效只提醒一次，重扫或续期成功后清除） */
  needRescan: boolean;
}

export function encryptCredential(c: DouyuCredential): string {
  const key = deriveKey(KEY_PURPOSE);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = deflateRawSync(Buffer.from(JSON.stringify(c), 'utf8'));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

/** 解不开 / 被改过 / 结构不对一律视为没有凭证 */
export function decryptCredential(token: string | undefined | null): DouyuCredential | null {
  if (!token) return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(KEY_PURPOSE), buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    const parsed = JSON.parse(inflateRawSync(plain).toString('utf8')) as Partial<DouyuCredential>;
    if (parsed.v !== 1 || typeof parsed.cookie !== 'string' || !parsed.cookie) return null;
    return {
      v: 1,
      cookie: parsed.cookie,
      ltp0: typeof parsed.ltp0 === 'string' ? parsed.ltp0 : '',
      dyDid: typeof parsed.dyDid === 'string' ? parsed.dyDid : '',
      uid: typeof parsed.uid === 'string' ? parsed.uid : '',
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
      issuedAt: Number(parsed.issuedAt) || 0,
      nextRenewAt: Number(parsed.nextRenewAt) || 0,
      needRescan: Boolean(parsed.needRescan),
    };
  } catch {
    return null;
  }
}

export function readDouyuCredential(req: Request): DouyuCredential | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const item of header.split(';')) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    if (item.slice(0, eq).trim() === DOUYU_COOKIE) return decryptCredential(item.slice(eq + 1).trim());
  }
  return null;
}

export function setDouyuCredentialCookie(res: NextResponse, c: DouyuCredential, secure: boolean): void {
  res.cookies.set(DOUYU_COOKIE, encryptCredential(c), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: COOKIE_MAX_AGE_S,
    path: DOUYU_COOKIE_PATH,
  });
}

export function clearDouyuCredentialCookie(res: NextResponse): void {
  res.cookies.set(DOUYU_COOKIE, '', { httpOnly: true, maxAge: 0, path: DOUYU_COOKIE_PATH });
}

// —— 策略（纯函数，便于测试） ——

export function credentialFromScan(login: DouyuScanLogin, now: number): DouyuCredential {
  return {
    v: 1,
    cookie: login.cookie,
    ltp0: login.ltp0,
    dyDid: login.dyDid,
    uid: login.uid,
    nickname: login.nickname,
    issuedAt: now,
    nextRenewAt: now + COOKIE_RENEW_INTERVAL_MS,
    needRescan: false,
  };
}

export type RenewOutcome =
  | { kind: 'renewed'; fields: Record<string, string> }
  /** 凭证本身失效（需重新扫码） */
  | { kind: 'invalid'; error: string }
  /** 网络 / 风控等临时失败 */
  | { kind: 'temporary'; error: string };

/**
 * 把一次换票结果落到凭证上（移植 bililive-go douyu_keeper 的日程规则）：
 * 成功 → 新字段并入（设备号按 applyDeviceIdPolicy 取舍），3 天后再续；
 * 失效 → 标记重扫，24h 后才再试；临时失败 → 6h 退避，但连续失败超过整个有效期即升级为失效。
 */
export function applyRenewOutcome(c: DouyuCredential, outcome: RenewOutcome, now: number): DouyuCredential {
  switch (outcome.kind) {
    case 'renewed': {
      const fresh = applyDeviceIdPolicy(c.cookie, outcome.fields);
      const merged = { ...parseCookieFields(c.cookie), ...fresh };
      let nickname = c.nickname;
      if (merged.acf_nickname) {
        try { nickname = decodeURIComponent(merged.acf_nickname); } catch { /* 保持原昵称 */ }
      }
      return {
        ...c,
        cookie: cookieString(merged),
        dyDid: c.dyDid || fresh.dy_did || '',
        uid: merged.acf_uid || c.uid,
        nickname,
        issuedAt: now,
        nextRenewAt: now + COOKIE_RENEW_INTERVAL_MS,
        needRescan: false,
      };
    }
    case 'invalid':
      return { ...c, needRescan: true, nextRenewAt: now + RENEW_INVALID_RETRY_BACKOFF_MS };
    case 'temporary':
      if (shouldEscalateTempFailure(c.issuedAt, now)) {
        return { ...c, needRescan: true, nextRenewAt: now + RENEW_INVALID_RETRY_BACKOFF_MS };
      }
      return { ...c, nextRenewAt: now + RENEW_RETRY_BACKOFF_MS };
  }
}

/**
 * 这份凭证此刻能不能当登录态发出去：只看主站 cookie 是否确凿过期。
 * 已标记重扫的凭证若 acf_* 还在有效期内照样可用（LTP0 死了不代表 acf_* 立刻死）。
 */
export function credentialUsable(c: DouyuCredential, now: number): boolean {
  return !loginCookieKnownExpired(c.issuedAt, now);
}

/** 给前端的非敏感摘要：绝不含 cookie / LTP0 / 设备号 */
export function sessionStatus(c: DouyuCredential | null, now: number): DouyuSessionStatus {
  if (!c) return { loggedIn: false };
  const expired = !credentialUsable(c, now);
  return {
    loggedIn: !expired,
    nickname: c.nickname,
    uid: c.uid,
    issuedAt: c.issuedAt,
    nextRenewAt: c.nextRenewAt,
    needRescan: c.needRescan,
    expired,
    canRenew: Boolean(c.ltp0),
  };
}
