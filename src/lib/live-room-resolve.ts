import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { deviceIdOf } from './douyu-auth';
import { fetchUpstream, fetchUpstreamWithMeta, getCache, setCache } from './fetch-utils';
import { canonicalLiveRoomUrl, parseLiveRoomUrl } from './live-room';
import type { LiveRoomInfo, LiveRoomStream } from './types';

/**
 * 平台直播间取流（服务端）：斗鱼 / 虎牙。
 *
 * 只有「算出带签名的流地址」这一步在服务端：平台流地址带签名、按小时过期，
 * 斗鱼的签名要执行它下发的混淆脚本，浏览器里做不了；而两家 CDN 都允许跨域直连
 * 且不校验 Referer（2026-10-15 实测），所以媒体流量由浏览器直连 CDN，不经本站代理，
 * 在 Vercel 这类有函数时长上限的平台上也能播 FLV 长连接。
 *
 * 算法移植自 bililive-go（src/live/huya/implForLol.go、src/live/douyu/douyu.go）。
 * 平台改版导致取流失败时，先对照该项目的最新实现调整。
 */

export class LiveRoomError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
/**
 * 解析结果缓存：开播状态与流地址共用一条。流地址有效期以小时计，
 * 列表构建、测活、播放器三处在一分钟内重复请求同一房间时直接复用；
 * 播放器遇到流地址失效用 force 绕过。
 */
const CACHE_TTL_MS = 60_000;
/** 同一房间并发请求合流：列表与测活同时触发时只打平台一次 */
const inflight = new Map<string, Promise<LiveRoomInfo>>();

/** 斗鱼登录态：主站 acf_* cookie 串与 uid（uid 只用来区分缓存，匿名与各账号的结果互不串） */
export interface DouyuAuthContext {
  cookie: string;
  uid: string;
}

export interface ResolveOptions {
  force?: boolean;
  /** 斗鱼取流带登录态：接口才给蓝光 / 原画，且匿名流约 5 分钟一断的问题消失 */
  douyu?: DouyuAuthContext;
}

export async function resolveLiveRoom(url: string, options: ResolveOptions = {}): Promise<LiveRoomInfo> {
  const ref = parseLiveRoomUrl(url);
  if (!ref) throw new LiveRoomError('仅支持斗鱼 / 虎牙的直播间地址', 400);
  const douyu = ref.platform === 'douyu' ? options.douyu : undefined;
  const key = `liveroom:${ref.platform}:${ref.roomKey.toLowerCase()}:${douyu ? `u${douyu.uid}` : 'anon'}`;
  if (!options.force) {
    const hit = getCache<LiveRoomInfo>(key);
    if (hit) return hit;
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const task = (ref.platform === 'huya' ? resolveHuya(ref.roomKey) : resolveDouyu(ref.roomKey, douyu))
    .then((info) => {
      setCache(key, info, CACHE_TTL_MS);
      return info;
    })
    .finally(() => {
      if (inflight.get(key) === task) inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/** 平台给的 CDN / 头像地址常是 http，本站为 https 时直连会被当混合内容拦截；两家 CDN 的 https 实测可用 */
function httpsify(url: string): string {
  return url.replace(/^http:\/\//i, 'https://');
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function optionalUrl(value: unknown): string | undefined {
  const s = text(value);
  return /^https?:\/\//i.test(s) ? httpsify(s) : undefined;
}

// —— 虎牙 ——

/** 页面脚本里 `var NAME = {...};` 形式的 JSON 变量 */
function extractPageJson(html: string, name: string): Record<string, unknown> | null {
  const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`));
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface HuyaStreamInfo {
  sCdnType?: string;
  sStreamName?: string;
  sFlvUrl?: string;
  sFlvUrlSuffix?: string;
  sFlvAntiCode?: string;
  sHlsUrl?: string;
  sHlsUrlSuffix?: string;
  sHlsAntiCode?: string;
}

async function resolveHuya(roomKey: string): Promise<LiveRoomInfo> {
  const res = await fetchUpstream(canonicalLiveRoomUrl('huya', roomKey), {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
  });
  if (!res.ok) throw new LiveRoomError(`虎牙房间页响应 ${res.status}`);
  const html = await res.text();
  if (html.includes('哎呀，虎牙君找不到这个主播')) throw new LiveRoomError('虎牙直播间不存在', 404);
  const profile = extractPageJson(html, 'TT_PROFILE_INFO');
  const roomData = extractPageJson(html, 'TT_ROOM_DATA');
  if (!profile || !roomData) throw new LiveRoomError('虎牙房间页结构已变化，需要更新适配');
  // 不存在的房间也返回 200 页面，只是 profileRoom 为 0、昵称为空
  const roomId = String(Number(profile.profileRoom) || 0);
  if (roomId === '0') throw new LiveRoomError('虎牙直播间不存在', 404);
  const living = roomData.state === 'ON' || roomData.isOn === true;
  return {
    platform: 'huya',
    roomUrl: canonicalLiveRoomUrl('huya', roomId),
    roomId,
    owner: text(profile.nick),
    title: text(roomData.introduction),
    avatar: optionalUrl(profile.avatar),
    living,
    streams: living ? huyaStreams(html) : [],
  };
}

/** hyPlayerConfig 里的 stream 字段（紧跟 `};` 结束）；兜底匹配对象后紧跟 iWebDefaultBitRate 的写法 */
function huyaStreamJson(html: string): { data?: { gameStreamInfoList?: HuyaStreamInfo[] }[] } | null {
  const candidates: string[] = [];
  const m1 = html.match(/stream:\s*(\{"data"[\s\S]*?)\s*\};/);
  if (m1) candidates.push(m1[1]);
  const m2 = html.match(/stream:\s*(\{"data"[\s\S]*?),"iWebDefaultBitRate"/);
  if (m2) candidates.push(`${m2[1]}}`);
  for (const raw of candidates) {
    try {
      return JSON.parse(raw) as { data?: { gameStreamInfoList?: HuyaStreamInfo[] }[] };
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

function huyaStreams(html: string): LiveRoomStream[] {
  const list = huyaStreamJson(html)?.data?.[0]?.gameStreamInfoList ?? [];
  if (list.length === 0) throw new LiveRoomError('虎牙房间页未给出流地址，页面结构可能已变化');
  const uid = 1200000000000 + Math.floor(Math.random() * 99999999999);
  const streams: LiveRoomStream[] = [];
  // 取前两条线路各自的 FLV + HLS：FLV 延迟低放前面，HLS 兜底（无 MSE 的 iOS 只能原生 HLS），
  // 第二条线路覆盖单 CDN 故障；再多的线路播放器也轮不到
  for (const cdn of list.slice(0, 2)) {
    const name = cdn.sStreamName;
    if (!name) continue;
    if (cdn.sFlvUrl && cdn.sFlvAntiCode) {
      streams.push({
        format: 'flv',
        url: `${httpsify(cdn.sFlvUrl)}/${name}.${cdn.sFlvUrlSuffix || 'flv'}?${huyaAntiCode(cdn.sFlvAntiCode, uid, name)}`,
        label: cdn.sCdnType,
      });
    }
    if (cdn.sHlsUrl && cdn.sHlsAntiCode) {
      streams.push({
        format: 'hls',
        url: `${httpsify(cdn.sHlsUrl)}/${name}.${cdn.sHlsUrlSuffix || 'm3u8'}?${huyaAntiCode(cdn.sHlsAntiCode, uid, name)}`,
        label: cdn.sCdnType,
      });
    }
  }
  if (streams.length === 0) throw new LiveRoomError('虎牙房间页未给出流地址，页面结构可能已变化');
  return streams;
}

/**
 * 虎牙 anti-code → 可播查询串（移植 bililive-go parseAntiCode）。
 * fm 是 base64 的签名模板：$0 用户 id / $1 流名 / $2 md5(seqid|ctype|t) / $3 wsTime，
 * 填好后整体 md5 即 wsSecret；sv 是播放器版本号，随 bililive-go 更新。
 */
export function huyaAntiCode(antiCode: string, uid: number, streamName: string): string {
  const q = new URLSearchParams(antiCode);
  const wsTime = q.get('wsTime') ?? '';
  const ctype = q.get('ctype') ?? '';
  const t = '100';
  const seqid = String(Date.now() + uid);
  const ss = md5(`${seqid}|${ctype}|${t}`);
  const fm = Buffer.from(q.get('fm') ?? '', 'base64')
    .toString('utf8')
    .replaceAll('$0', String(uid))
    .replaceAll('$1', streamName)
    .replaceAll('$2', ss)
    .replaceAll('$3', wsTime);
  const wsSecret = md5(fm);
  return (
    `wsSecret=${wsSecret}&wsTime=${wsTime}&seqid=${seqid}&ctype=${ctype}&ver=1` +
    `&fs=${q.get('fs') ?? ''}&u=${uid}&t=${t}&sv=2405220949&sdk_sid=${uid}&codec=264`
  );
}

// —— 斗鱼 ——

const DOUYU_ORIGIN = 'https://www.douyu.com';
/** 签名用设备号：进程内固定。频繁更换设备号是斗鱼风控的触发点（见 bililive-go getDID 注释） */
const DOUYU_DID = randomUUID().replace(/-/g, '');
const DOUYU_ROOM_ID_RES = [
  /\$ROOM\.room_id\s*=\s*(\d+)/,
  /room_id\s*=\s*(\d+)/,
  /"room_id.?":(\d+)/,
  /data-onlineid=(\d+)/,
];

interface DouyuBetard {
  room?: Record<string, unknown>;
}
interface DouyuH5Play {
  error?: number;
  msg?: string;
  data?: {
    rtmp_url?: string;
    rtmp_live?: string;
    rtmp_cdn?: string;
    /** 实际下发的画质档，对应 multirates[].rate */
    rate?: number;
    multirates?: { name?: string; rate?: number }[];
  };
}

/** 斗鱼接口：非 JSON 返回 null（房间不存在时 betard 回的是 HTML 页）；带登录 cookie 时所有请求都带 */
async function fetchDouyuJson<T>(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; cookie?: string } = {}
): Promise<T | null> {
  const res = await fetchUpstream(url, {
    timeoutMs: TIMEOUT_MS,
    method: init.method,
    body: init.body,
    headers: {
      'User-Agent': UA,
      Referer: `${DOUYU_ORIGIN}/`,
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new LiveRoomError(`斗鱼接口响应 ${res.status}`);
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

async function resolveDouyu(roomKey: string, auth?: DouyuAuthContext): Promise<LiveRoomInfo> {
  const rid = /^\d+$/.test(roomKey) ? roomKey : await douyuRoomIdOfAlias(roomKey);
  const room = (await fetchDouyuJson<DouyuBetard>(`${DOUYU_ORIGIN}/betard/${rid}`, { cookie: auth?.cookie }))?.room;
  if (!room || !room.room_id) throw new LiveRoomError('斗鱼直播间不存在', 404);
  const roomId = String(room.room_id);
  // show_status 1=开播 2=未开播；videoLoop 1=录像轮播，不算直播（与 bililive-go 口径一致）
  const living = Number(room.show_status) === 1 && Number(room.videoLoop ?? 0) === 0;
  const avatar = (room.avatar ?? {}) as { middle?: string; big?: string };
  const play = living ? await douyuStreams(roomId, auth) : { streams: [], quality: undefined };
  return {
    platform: 'douyu',
    roomUrl: canonicalLiveRoomUrl('douyu', roomId),
    roomId,
    owner: text(room.owner_name) || text(room.nickname),
    title: text(room.room_name),
    avatar: optionalUrl(avatar.middle ?? avatar.big ?? room.avatar_mid ?? room.owner_avatar),
    living,
    streams: play.streams,
    quality: play.quality,
    loggedIn: Boolean(auth),
  };
}

/** 别名地址（douyu.com/yyf）→ 数字房间号：站点通常 302 到数字路径，否则从页面脚本里找 room_id */
async function douyuRoomIdOfAlias(alias: string): Promise<string> {
  const { res, finalUrl } = await fetchUpstreamWithMeta(`${DOUYU_ORIGIN}/${alias}`, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
  });
  const fromPath = new URL(finalUrl).pathname.match(/^\/(\d+)\/?$/)?.[1];
  if (fromPath) {
    try { await res.body?.cancel(); } catch { /* 忽略 */ }
    return fromPath;
  }
  if (!res.ok) {
    if (res.status === 404) throw new LiveRoomError('斗鱼直播间不存在', 404);
    throw new LiveRoomError(`斗鱼房间页响应 ${res.status}`);
  }
  const html = await res.text();
  for (const re of DOUYU_ROOM_ID_RES) {
    const m = html.match(re);
    if (m) return m[1];
  }
  throw new LiveRoomError('斗鱼直播间不存在', 404);
}

async function douyuStreams(
  rid: string,
  auth?: DouyuAuthContext
): Promise<{ streams: LiveRoomStream[]; quality?: string }> {
  const enc = await fetchDouyuJson<{ error?: number; data?: Record<string, string> }>(
    `${DOUYU_ORIGIN}/swf_api/homeH5Enc?rids=${rid}`,
    { cookie: auth?.cookie }
  );
  const jsEnc = enc?.data?.[`room${rid}`];
  if (!jsEnc) throw new LiveRoomError('斗鱼签名脚本获取失败');
  // 带登录态时签名用的设备号必须是 cookie 里那一个，否则偶发签名被拒退回匿名
  const did = (auth && deviceIdOf(auth.cookie)) || DOUYU_DID;
  const params = douyuSign(jsEnc, rid, did);
  // rate=0 让服务端选默认档：匿名不论要哪一档都只给「高清」，带登录态才给蓝光 / 原画。
  // hevc=0 只要 H.264，浏览器软解无压力。
  const play = await fetchDouyuJson<DouyuH5Play>(`${DOUYU_ORIGIN}/lapi/live/getH5Play/${rid}`, {
    method: 'POST',
    body: `${params}&cdn=&rate=0&ver=Douyu_223061205&iar=1&ive=1&hevc=0&fa=0`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: DOUYU_ORIGIN,
      Referer: `${DOUYU_ORIGIN}/${rid}`,
    },
    cookie: auth?.cookie,
  });
  if (!play || play.error !== 0 || !play.data?.rtmp_url || !play.data.rtmp_live) {
    throw new LiveRoomError(`斗鱼取流失败：${play?.msg || `错误码 ${play?.error ?? '未知'}`}`);
  }
  const quality = play.data.multirates?.find((m) => m.rate === play.data?.rate)?.name || undefined;
  return {
    streams: [
      {
        format: 'flv',
        url: httpsify(`${play.data.rtmp_url}/${play.data.rtmp_live}`),
        label: play.data.rtmp_cdn,
      },
    ],
    quality,
  };
}

/**
 * 执行斗鱼下发的混淆签名脚本 ub98484234(rid, did, ts)，得到 v/did/tt/sign 查询串。
 * 脚本依赖 CryptoJS.MD5，用 node:crypto 垫出同名接口，不引入整包 crypto-js。
 * vm 不是安全边界：脚本来自 douyu.com 的 HTTPS 响应，信任等级与 bililive-go 一致；
 * timeout 只防脚本死循环拖住请求。
 */
export function douyuSign(jsEnc: string, rid: string, did: string = DOUYU_DID): string {
  if (!/function\s+ub98484234\s*\(/.test(jsEnc)) {
    throw new LiveRoomError('斗鱼签名脚本格式已变化，需要更新适配');
  }
  const context = vm.createContext({
    window: {},
    document: {},
    console: { log() {}, warn() {}, error() {} },
    CryptoJS: { MD5: (input: unknown) => ({ toString: () => md5(String(input)) }) },
  });
  const tt = Math.floor(Date.now() / 1000);
  let result: unknown;
  try {
    result = vm.runInContext(
      `${jsEnc}\n;ub98484234(${JSON.stringify(rid)}, ${JSON.stringify(did)}, ${tt})`,
      context,
      { timeout: 3000 }
    );
  } catch (err) {
    throw new LiveRoomError(`斗鱼签名脚本执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const params = typeof result === 'string' ? result : '';
  if (!/(^|&)sign=[0-9a-f]{32}(&|$)/.test(params)) throw new LiveRoomError('斗鱼签名脚本返回了意外结果');
  return params;
}
