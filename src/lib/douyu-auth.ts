/**
 * 斗鱼扫码登录与登录态续期（服务端）。协议移植自 bililive-go src/live/douyu/{auth,refresh}.go（2026-10 实测抓包）：
 *
 * 扫码：POST passport.douyu.com/scan/generateCode → 轮询 /japi/scan/auth
 *       （error -2 未扫码 / 1 已扫码待确认 / 0 确认成功 / -1 二维码失效）→ 成功后 GET data.url，
 *       手动逐跳跟随 302 收集每一跳的 Set-Cookie，得到主站 acf_* 登录态；
 *       轮询成功那一次响应的 Set-Cookie 里有 passport 域的长期凭证 LTP0（数月有效）。
 * 续期：主站 acf_* 只有约 6 天（Max-Age≈529200s）且网页端不被动续签；
 *       带 LTP0 请求 safeAuth → 302 到 www.douyu.com/api/passport/login 的一次性地址 → 下发全套新 acf_*
 *       （safeAuth 不重发 LTP0）；再用关注接口探针确认登录态真实有效。
 *
 * 所有请求只打 *.douyu.com（跳转目标逐跳校验）；错误信息不带上游正文：风控页是 HTTP 200 + HTML，
 * 原样带出去既误导排障又把上游页面漏进日志。
 */

export const DOUYU_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const QR_GENERATE_URL = 'https://passport.douyu.com/scan/generateCode';
const QR_POLL_URL = 'https://passport.douyu.com/japi/scan/auth';
const QR_LOGIN_REFERER = 'https://passport.douyu.com/index/login';
const SAFE_AUTH_URL = 'https://passport.douyu.com/lapi/passport/iframe/safeAuth';
const PROBE_URL = 'https://www.douyu.com/wgapi/livenc/liveweb/follow/top3';
const MAX_HOPS = 8;
const TIMEOUT_MS = 15_000;
const BODY_LIMIT = 1 << 20;
const QR_CODE_RE = /^[0-9a-f]{32}$/;

/** 换票后判定「真的登录了」的必需字段：缺任一即视为未真正登录（实测抓包） */
export const DOUYU_REQUIRED_COOKIE_KEYS = ['acf_uid', 'acf_auth', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct'];
/** 斗鱼侧设备标识字段，按优先级；签名用的 did 必须与登录 cookie 里的一致，否则偶发签名被拒 */
export const DOUYU_DEVICE_ID_KEYS = ['dy_did', 'acf_did', 'acf_devid'];

// —— 时间策略（移植 refresh.go，单位 ms） ——

/** 主站 acf_* 实际约 6 天有效，取 3 天续期一次，留一倍缓冲 */
export const COOKIE_RENEW_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
/** 换票临时失败（网络 / 风控）后的重试退避：登录类接口反复调用最容易触发风控 */
export const RENEW_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** 已判定凭证失效之后的重试退避：用户不会在几小时内重扫，同一张死票每天打 4 次只会招风控 */
export const RENEW_INVALID_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** 临时失败持续超过主站 cookie 整个有效期，登录态必然已过期，不再是「稍后再试」 */
export const RENEW_ESCALATE_AFTER_MS = 6 * 24 * 60 * 60 * 1000;
/** 主站 acf_* 的 Max-Age（实测 529200s ≈ 6.1 天） */
export const MAIN_SITE_COOKIE_MAX_AGE_MS = 529200 * 1000;
/** 判定 cookie 确实过期时的余量：按 6 天整数判会在最后几小时把还能用的登录态降级成匿名 */
export const DEAD_COOKIE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** 凭证本身失效（LTP0 过期 / 换票缺字段 / 探针判未登录），需重新扫码；区别于网络抖动等临时错误 */
export class DouyuLoginInvalidError extends Error {}

/**
 * 是否该真正发起换票。续期日程是按当前时钟写下的绝对时间：时钟被回拨后「还没到点」是假信号，
 * 而主站 cookie 的 6 天是按真实时间在耗，所以到点之外再允许两个提前理由：日程基准落在未来、
 * 距上次成功已超过整个有效期。两个提前理由都让位给最近写下的退避日程（6h / 24h 以内），
 * 否则 safeAuth 会被每小时的检查反复调用。
 */
export function shouldRenewNow(nextRenewAt: number, lastSuccessAt: number, now: number): boolean {
  if (!nextRenewAt) return true;
  if (now >= nextRenewAt) return true;
  if (!lastSuccessAt) return false;
  if (nextRenewAt - now <= RENEW_INVALID_RETRY_BACKOFF_MS) return false;
  return now < lastSuccessAt || now - lastSuccessAt > RENEW_ESCALATE_AFTER_MS;
}

/** 临时性失败是否该升级为「需重新扫码」：距上次成功超过主站 cookie 整个有效期 */
export function shouldEscalateTempFailure(lastSuccessAt: number, now: number): boolean {
  return lastSuccessAt > 0 && now - lastSuccessAt > RENEW_ESCALATE_AFTER_MS;
}

/**
 * 这份主站登录 cookie 是否已有确凿证据彻底失效：距上次拿到新鲜登录态超过 Max-Age + 余量。
 * 确凿过期的 acf_* 再发出去换不到任何权益，只会让斗鱼把整条请求拒掉（房间完全播不了而不是退回匿名），
 * 所以到点主动停用，回到匿名路径。
 */
export function loginCookieKnownExpired(lastSuccessAt: number, now: number): boolean {
  if (!lastSuccessAt) return false;
  return now - lastSuccessAt > MAIN_SITE_COOKIE_MAX_AGE_MS + DEAD_COOKIE_MARGIN_MS;
}

// —— cookie 串工具 ——

/** "k1=v1; k2=v2" → 字段表；空值忽略（空值 Set-Cookie 是清除写法） */
export function parseCookieFields(cookie: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const item of cookie.split(';')) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (name && value) fields[name] = value;
  }
  return fields;
}

/** 字段表 → 按字段名排序的 cookie 串（输出稳定，便于比较与测试） */
export function cookieString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .sort()
    .filter((k) => fields[k])
    .map((k) => `${k}=${fields[k]}`)
    .join('; ');
}

export function cookieValue(cookie: string, name: string): string {
  return parseCookieFields(cookie)[name] ?? '';
}

export function hasStoredDeviceId(cookie: string): boolean {
  const fields = parseCookieFields(cookie);
  return DOUYU_DEVICE_ID_KEYS.some((k) => Boolean(fields[k]));
}

/** 登录 cookie 里的斗鱼设备号（签名用 did 必须与之一致） */
export function deviceIdOf(cookie: string): string | undefined {
  const fields = parseCookieFields(cookie);
  for (const k of DOUYU_DEVICE_ID_KEYS) {
    if (fields[k]) return fields[k];
  }
  return undefined;
}

/**
 * 一次换票换到的字段里，设备号该丢还是该补种（唯一决策点，返回副本）：
 * 现有 cookie 已有设备号 → 挡掉本次签发的新值（设备号在扫码那次定下并长期沿用，
 * 跟着续期轮换等于每 3 天换一台新设备，是风控诱因）；一个都没有 → 补种一次，之后即稳定。
 */
export function applyDeviceIdPolicy(storedCookie: string, fields: Record<string, string>): Record<string, string> {
  const hasStored = hasStoredDeviceId(storedCookie);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (hasStored && DOUYU_DEVICE_ID_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// —— 上游请求 ——

interface DouyuResponse {
  status: number;
  body: string;
  /** 本跳 Set-Cookie 的非空字段 */
  setCookies: Record<string, string>;
  /** 本跳 Set-Cookie 出现过的字段名（含空值），只用于诊断串 */
  cookieNames: string[];
  location: string | null;
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= BODY_LIMIT) {
        try { await reader.cancel(); } catch { /* 忽略 */ }
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 单次请求，不自动跟随跳转（中间跳的 Set-Cookie 才是登录态所在） */
async function douyuRequest(
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; cookie?: string } = {}
): Promise<DouyuResponse> {
  const headers: Record<string, string> = { 'User-Agent': DOUYU_UA, ...init.headers };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const setCookies: Record<string, string> = {};
  const cookieNames: string[] = [];
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    cookieNames.push(name);
    if (value) setCookies[name] = value;
  }
  const body = await readLimited(res);
  return { status: res.status, body, setCookies, cookieNames, location: res.headers.get('location') };
}

/** 斗鱼业务响应一律 HTTP 200 + JSON 的 error 字段；拿不到 error 字段就不是 API 响应（风控页以 200 回 HTML） */
function parseApiJson(body: string): { error: number; data?: unknown; msg?: string } | null {
  try {
    const j = JSON.parse(body) as { error?: unknown; data?: unknown; msg?: unknown };
    if (typeof j.error !== 'number') return null;
    return { error: j.error, data: j.data, msg: typeof j.msg === 'string' ? j.msg : undefined };
  } catch {
    return null;
  }
}

/** 只允许斗鱼官方域名的 https 地址（跳转目标逐跳校验，防被诱导请求任意地址） */
export function checkDouyuUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('回调地址解析失败');
  }
  if (u.protocol !== 'https:') throw new Error(`拒绝非 HTTPS 回调: ${u.protocol}`);
  if (u.hostname !== 'douyu.com' && !u.hostname.endsWith('.douyu.com')) {
    throw new Error(`拒绝请求非斗鱼域名回调: ${u.hostname}`);
  }
  return u;
}

/** 解析可能为 //host 或相对形式的 Location，并过域名白名单 */
export function resolveDouyuRedirect(base: string, location: string): string {
  const loc = location.startsWith('//') ? `https:${location}` : location;
  let resolved: string;
  try {
    resolved = new URL(loc, base).href;
  } catch {
    throw new Error('跳转地址解析失败');
  }
  return checkDouyuUrl(resolved).href;
}

/** JSONP 响应取出 JSON 主体：cb({...}); → {...} */
export function stripJsonp(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  return raw.slice(start, end + 1);
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pickFirstString(jsonBody: string, paths: string[]): string {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonBody);
  } catch {
    return '';
  }
  for (const p of paths) {
    const v = getPath(obj, p);
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function hopLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * 从起始地址手动逐跳跟随 3xx，累积每一跳的 Set-Cookie；每跳带同一份 cookie（续期链用 LTP0）。
 * 返回终点状态码：0 表示跳数用尽仍未到终点；3xx 而无 Location 时返回该 3xx（链在此中断）。
 * 诊断串只记录 cookie 名与 scheme://host/path：一次性登录 token 就在 query 里，不能进日志。
 */
async function followHops(
  start: string,
  opts: { cookie?: string; referer: string }
): Promise<{ fields: Record<string, string>; status: number; body: string; trace: string }> {
  const fields: Record<string, string> = {};
  const hops: string[] = [];
  let cur = checkDouyuUrl(start).href;
  let status = 0;
  let body = '';
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await douyuRequest(cur, { headers: { Referer: opts.referer }, cookie: opts.cookie });
    Object.assign(fields, res.setCookies);
    hops.push(`${hopLabel(cur)} -> ${res.status} (Set-Cookie: ${res.cookieNames.join(',') || '-'})`);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) {
        status = res.status;
        break;
      }
      cur = resolveDouyuRedirect(cur, res.location);
      continue;
    }
    status = res.status;
    body = res.body;
    break;
  }
  return { fields, status, body, trace: hops.join('; ') };
}

// —— 扫码登录 ——

export interface DouyuQrSession {
  /** 轮询用的会话 code（32 位 hex） */
  code: string;
  /** 二维码内容（斗鱼中间页链接），用斗鱼 App 扫 */
  qrUrl: string;
  /** 有效期（秒） */
  expire: number;
}

export async function generateLoginQr(): Promise<DouyuQrSession> {
  const res = await douyuRequest(QR_GENERATE_URL, {
    method: 'POST',
    headers: {
      Referer: QR_LOGIN_REFERER,
      Origin: 'https://passport.douyu.com',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'client_id=1&isMultiAccount=0',
  });
  if (res.status >= 400) throw new Error(`斗鱼登录接口返回 HTTP ${res.status}（可能被风控或接口已变更）`);
  const j = parseApiJson(res.body);
  if (!j) throw new Error(`斗鱼二维码接口响应不是预期 JSON（疑似风控页或接口已变更），响应长度 ${res.body.length} 字节`);
  if (j.error !== 0) throw new Error(`斗鱼返回错误: ${String(typeof j.data === 'string' ? j.data : j.msg ?? j.error).trim()}`);
  const data = (j.data ?? {}) as { code?: unknown; url?: unknown; expire?: unknown };
  const code = typeof data.code === 'string' ? data.code : '';
  const qrUrl = typeof data.url === 'string' ? data.url : '';
  if (!QR_CODE_RE.test(code) || !qrUrl) throw new Error(`斗鱼二维码响应异常（code/url 不完整），响应长度 ${res.body.length} 字节`);
  return { code, qrUrl, expire: Number(data.expire) || 300 };
}

export type DouyuQrState = 'waiting' | 'scanned' | 'success' | 'expired' | 'rejected';

export interface DouyuScanLogin {
  /** 主站登录 cookie 串（acf_* 全家桶，按字段名排序） */
  cookie: string;
  /** passport 域长期凭证，续期用；为空表示本次没拿到，6 天后只能重扫 */
  ltp0: string;
  dyDid: string;
  uid: string;
  nickname: string;
}

export interface DouyuQrPoll {
  state: DouyuQrState;
  msg?: string;
  /** 仅 success 时有值 */
  login?: DouyuScanLogin;
}

export async function pollLoginQr(code: string): Promise<DouyuQrPoll> {
  if (!QR_CODE_RE.test(code)) throw new Error('非法的二维码 code');
  const res = await douyuRequest(`${QR_POLL_URL}?time=${Date.now()}&code=${code}`, {
    headers: { Referer: QR_LOGIN_REFERER, 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (res.status >= 400) throw new Error(`斗鱼登录接口返回 HTTP ${res.status}（可能被风控或接口已变更）`);
  const j = parseApiJson(res.body);
  // 按「缺省即 0」继续走会被当成确认成功去换票，最终吐出一句「缺少回调 URL」
  if (!j) throw new Error(`斗鱼扫码状态轮询响应不是预期 JSON（疑似风控页或接口已变更），响应长度 ${res.body.length} 字节`);
  switch (j.error) {
    case 0: {
      const exchangeUrl = typeof (j.data as { url?: unknown } | undefined)?.url === 'string' ? ((j.data as { url: string }).url) : '';
      if (!exchangeUrl) throw new Error(`斗鱼登录确认成功但响应缺少回调 URL（接口可能已变更），响应长度 ${res.body.length} 字节`);
      const { cookie, body, trace } = await exchangeLoginCookie(exchangeUrl);
      if (!cookie) throw new Error(`斗鱼登录确认成功但未获得 Set-Cookie，接口可能已变更; ${trace}`);
      // 探针确认这份 cookie 真的算登录态：跳转链也可能收敛到一个不下发 acf_* 的页面。
      // 只有探针明确给出「未登录」业务码才判失败；风控页、网络抖动这类 ambiguous 异常按原样放行，
      // 不能因为探针这一次没打通就把用户刚完成的真实登录作废。
      try {
        await verifyLoginCookie(cookie);
      } catch (err) {
        if (err instanceof DouyuLoginInvalidError) {
          throw new Error(`斗鱼登录 Cookie 未通过登录态校验，请重新扫码: ${err.message}; ${trace}`);
        }
      }
      let nickname = pickFirstString(body, ['nickname', 'user_nickname', 'uname', 'data.nickname']);
      let uid = pickFirstString(body, ['uid', 'user_id', 'id', 'data.uid']);
      // JSONP 回调结构可能变化，cookie 里的 acf_uid / acf_nickname 更稳定
      if (!uid) uid = cookieValue(cookie, 'acf_uid');
      if (!nickname) {
        const enc = cookieValue(cookie, 'acf_nickname');
        if (enc) {
          try { nickname = decodeURIComponent(enc); } catch { nickname = enc; }
        }
      }
      // LTP0 由轮询 error=0 响应的 Set-Cookie 下发（passport 域），是续期的关键长期凭证
      const ltp0 = res.setCookies.LTP0 || cookieValue(cookie, 'LTP0');
      const dyDid = res.setCookies.dy_did || cookieValue(cookie, 'dy_did');
      // LTP0 只该存在凭证的 ltp0 一处，不混进主站 cookie 串
      const fields = parseCookieFields(cookie);
      delete fields.LTP0;
      return { state: 'success', login: { cookie: cookieString(fields), ltp0, dyDid, uid, nickname } };
    }
    case 1:
      return { state: 'scanned', msg: j.msg };
    case -2:
      return { state: 'waiting', msg: j.msg };
    case -1:
      return { state: 'expired', msg: j.msg };
    default:
      return { state: 'rejected', msg: j.msg };
  }
}

/**
 * 请求登录成功回调地址（JSONP），逐跳收集 Set-Cookie 得登录态。
 * 斗鱼可能在 302 链的中间跳下发登录 cookie，自动跟随只能看到最后一跳。
 */
export async function exchangeLoginCookie(rawUrl: string): Promise<{ cookie: string; body: string; trace: string }> {
  const { fields, status, body, trace } = await followHops(rawUrl, { referer: QR_LOGIN_REFERER });
  if (status === 0) {
    // 8 跳仍未落到终点：带着半截 cookie 返回会被当成登录成功落盘，面板显示已登录而实际播不了
    throw new Error(`斗鱼登录回调连续 ${MAX_HOPS} 跳仍未到达终点，接口可能已变更; ${trace}`);
  }
  if (status >= 300 && status < 400) {
    throw new Error(`斗鱼登录回调返回 HTTP ${status} 但未给出跳转地址，登录链中断; ${trace}`);
  }
  if (status >= 400) {
    throw new Error(`斗鱼登录回调终点返回 HTTP ${status}（风控或接口变更），未获得登录态; ${trace}`);
  }
  return { cookie: cookieString(fields), body: stripJsonp(body), trace };
}

// —— 登录态校验与续期 ——

/**
 * 用关注接口探针确认登录态真实有效：HTTP 200 且 JSON 带 error 字段且为 0 才算
 * （关注主播此刻可能都没开播，room_list 为空同样算有效）。
 * 明确的「未登录」业务码 → DouyuLoginInvalidError；HTTP / 网络 / 非预期 JSON → 临时错误。
 * 风控页以 200 + HTML 返回、没有 error 字段：若当成 0 会把无效 cookie 当成功，数日静默退回匿名。
 */
export async function verifyLoginCookie(cookie: string): Promise<void> {
  const res = await douyuRequest(PROBE_URL, { headers: { Referer: 'https://www.douyu.com/' }, cookie });
  if (res.status !== 200) throw new Error(`登录态探针 HTTP ${res.status}（临时性错误）`);
  const j = parseApiJson(res.body);
  if (!j) throw new Error('登录态探针响应不含 error 字段（疑似风控页或接口变更），暂不判定登录态有效');
  if (j.error !== 0) throw new DouyuLoginInvalidError(`探针 error=${j.error}, msg=${j.msg ?? ''}`);
}

/**
 * 用 LTP0 经 safeAuth 换取全新的主站登录 cookie 字段（只含本次换到的字段，调用方负责合并写回）。
 * 必需字段缺失或探针判未登录 → DouyuLoginInvalidError（通常 LTP0 也过期了，需重新扫码）。
 */
export async function refreshLoginCookie(ltp0: string, dyDid: string): Promise<Record<string, string>> {
  if (!ltp0.trim()) throw new Error('缺少 LTP0，无法续期');
  const cookie = `${dyDid ? `dy_did=${dyDid}; ` : ''}LTP0=${ltp0}`;
  const ts = Date.now();
  const start = `${SAFE_AUTH_URL}?client_id=1&t=${ts}&_=${ts}&callback=cb`;
  const { fields, status } = await followHops(start, { cookie, referer: 'https://www.douyu.com/' });
  // 只有终点 200 的响应才可能带 acf_*；4xx/5xx（风控、限流、改版）与「LTP0 过期」无关，必须按临时错误返回，
  // 否则会因字段缺失误判凭证失效而推送假的重扫提醒。status 0 = 跳数用尽，同样按临时错误。
  if (status !== 200) throw new Error(`safeAuth 换票链未正常结束（终点 HTTP ${status}），暂不判定登录态是否失效`);
  const missing = DOUYU_REQUIRED_COOKIE_KEYS.filter((k) => !fields[k]);
  if (missing.length > 0) {
    throw new DouyuLoginInvalidError(`换票响应缺少必需字段 ${missing.join(',')}，LTP0 可能已过期`);
  }
  // safeAuth 不重发 LTP0；万一带了也不能混进主站 cookie 串
  delete fields.LTP0;
  await verifyLoginCookie(cookieString(fields));
  return fields;
}
