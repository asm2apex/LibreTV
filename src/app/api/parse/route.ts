import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchUpstream, fetchUpstreamWithMeta, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { buildApiUrl, getParseApiTemplate } from '@/lib/env-parse-api';
import { needsParse } from '@/lib/episode-url';
import { absolutizeM3u8, makeAbsolute } from '@/lib/m3u8';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 官源解析：把爱奇艺 / 腾讯 / 优酷 / 芒果 / B 站等平台的页面地址换成可播的 HLS 清单。
 * GET /api/parse?url=<平台页面地址>[&refresh=1]
 *
 * 为什么返回清单文本而不是直链：实测解析出的 m3u8 地址约 10 秒即过期，
 * 交给浏览器再去取基本来不及，hls.js 的重试 / 预取器 / 下载器任何一次重新拉取都会 404；
 * 而清单里的分片是公网 CDN 上的长寿资源、CORS 全开、其他 IP 也能直取。
 * 因此服务端在同一次请求内立刻取回清单、按页面地址缓存文本，播放器以本站地址为 m3u8 源，
 * 分片直连 CDN——密钥不出服务器，媒体流量不过服务器，重复播放不重复付费解析。
 *
 * 只替官方平台的页面付费解析（needsParse 白名单），避免登录用户拿部署者的额度乱解析。
 */

/** 清单缓存时长：分片实测比清单活得久得多；1 小时内重播 / 预取 / 下载都走缓存，refresh=1 可强制重解析 */
const PLAYLIST_CACHE_TTL_MS = 60 * 60 * 1000;
const PARSE_TIMEOUT_MS = 15_000;
const PLAYLIST_TIMEOUT_MS = 10_000;
/** 清单体积上限：正常几十 KB，超限视为异常响应 */
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_URL_LEN = 2048;
const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface CachedPlaylist {
  text: string;
}

type PlaylistFetch = { text: string; finalUrl: string } | { error: string; status: number };

function playlistResponse(text: string, cacheState: 'hit' | 'miss' | 'refresh'): NextResponse {
  return new NextResponse(text, {
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      // 登录态资源：不得被共享缓存命中（与 /api/proxy 的 public 缓存头是两回事）
      'Cache-Control': 'private, no-store',
      'X-Parse-Cache': cacheState,
    },
  });
}

/**
 * 厂商 JSON → 播放地址。字段取法对齐厂商自家播放器：url / play_url / data.url；
 * 拿不到地址即视为失败，厂商的 msg（如「密钥失效」）原样透出给用户定位。
 */
function extractMediaUrl(body: unknown): { url: string } | { error: string } {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const data = (record.data && typeof record.data === 'object' ? record.data : {}) as Record<string, unknown>;
  const candidate = record.url ?? record.play_url ?? data.url;
  if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) {
    return { url: candidate.trim() };
  }
  // 厂商 msg 常常就是「解析失败」本身，叠上本站前缀会变成「解析失败：解析失败」，先剥掉同义前缀
  const raw = typeof record.msg === 'string' ? record.msg.trim().replace(/^解析失败[:：]?\s*/, '') : '';
  return { error: raw || '解析接口未返回播放地址' };
}

/** master playlist 时取带宽最高的变体（绝对地址）；media playlist 返回 null */
function pickTopVariant(text: string, base: string): string | null {
  if (!text.includes('#EXT-X-STREAM-INF')) return null;
  let best: { bandwidth: number; url: string } | null = null;
  let pending: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      pending = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (pending !== null) {
      if (!best || pending > best.bandwidth) best = { bandwidth: pending, url: makeAbsolute(line, base) };
      pending = null;
    }
  }
  return best?.url ?? null;
}

async function fetchPlaylistText(url: string): Promise<PlaylistFetch> {
  const { res, finalUrl } = await fetchUpstreamWithMeta(url, {
    timeoutMs: PLAYLIST_TIMEOUT_MS,
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });
  if (!res.ok) return { error: `清单拉取失败：HTTP ${res.status}`, status: 502 };
  const text = await res.text();
  if (text.length > MAX_PLAYLIST_BYTES) return { error: '清单体积异常，已拒绝', status: 502 };
  if (!/^﻿?\s*#EXTM3U/.test(text)) return { error: '解析结果不是 HLS 播放列表，暂不支持', status: 415 };
  return { text, finalUrl };
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const pageUrl = (sp.get('url') || '').trim();
  const refresh = sp.get('refresh') === '1';
  if (!pageUrl || pageUrl.length > MAX_PAGE_URL_LEN || !needsParse(pageUrl)) {
    return jsonError('仅支持解析官方视频平台的页面地址', 400);
  }
  const template = getParseApiTemplate();
  if (!template) return jsonError('服务器未配置解析接口（PARSE_API）', 501);

  const cacheKey = `parse:${pageUrl}`;
  if (!refresh) {
    const hit = getCache<CachedPlaylist>(cacheKey);
    if (hit) return playlistResponse(hit.text, 'hit');
  }

  // 模板由部署者配置，但仍过一遍 SSRF：填错成内网地址时在这里报错比静默请求内网更安全
  const apiUrl = buildApiUrl(template, pageUrl);
  const apiVerdict = await checkUpstreamAllowed(apiUrl);
  if (!apiVerdict.ok) return jsonError(`解析接口地址不可用：${apiVerdict.reason}`, 500);

  let body: unknown;
  try {
    const res = await fetchUpstream(apiUrl, {
      timeoutMs: PARSE_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return jsonError(`解析接口返回 HTTP ${res.status}`, 502);
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError('解析接口返回的不是 JSON', 502);
    }
  } catch (err) {
    return jsonError(`解析接口请求失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }

  const extracted = extractMediaUrl(body);
  if ('error' in extracted) return jsonError(`解析失败：${extracted.error}`, 502);
  // 厂商返回的地址不可信：拒绝内网 / 非 http(s)，否则服务器会替它探内网
  const mediaVerdict = await checkUpstreamAllowed(extracted.url);
  if (!mediaVerdict.ok) return jsonError(`解析结果地址不可用：${mediaVerdict.reason}`, 502);

  try {
    let fetched = await fetchPlaylistText(extracted.url);
    if ('error' in fetched) return jsonError(fetched.error, fetched.status);
    // master 清单里的子清单同样短命，一并在本次请求内穿透到 media 清单
    const variant = pickTopVariant(fetched.text, fetched.finalUrl);
    if (variant) {
      fetched = await fetchPlaylistText(variant);
      if ('error' in fetched) return jsonError(fetched.error, fetched.status);
    }
    // 清单以本站地址下发，播放器失去原始基址，相对分片地址必须在此落实为绝对地址
    const playlist = absolutizeM3u8(fetched.text, fetched.finalUrl);
    setCache(cacheKey, { text: playlist }, PLAYLIST_CACHE_TTL_MS);
    return playlistResponse(playlist, refresh ? 'refresh' : 'miss');
  } catch (err) {
    return jsonError(`清单拉取失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
