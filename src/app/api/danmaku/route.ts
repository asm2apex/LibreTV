import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { buildApiUrl, getDanmakuApiTemplate } from '@/lib/env-parse-api';
import { needsParse } from '@/lib/episode-url';
import { normalizeDanmaku } from '@/lib/danmaku';
import type { DanmakuResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 官源弹幕：按平台页面地址取该集弹幕，归一化后下发。
 * GET /api/danmaku?url=<平台页面地址>
 *
 * 与 /api/parse 同一套边界：登录保护、只替官方平台页面付费拉取、模板含密钥只留服务端。
 * 弹幕内容几乎不变且单集上百 KB，服务端缓存 6 小时，多人观看同一集只付费一次。
 */

const DANMAKU_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DANMAKU_TIMEOUT_MS = 20_000;
/** 响应体积上限：一集弹幕通常 100–300KB，超限视为异常 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_URL_LEN = 2048;
const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function respond(payload: DanmakuResponse, cacheState: 'hit' | 'miss'): NextResponse {
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'private, no-store', 'X-Danmaku-Cache': cacheState },
  });
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const pageUrl = (new URL(req.url).searchParams.get('url') || '').trim();
  if (!pageUrl || pageUrl.length > MAX_PAGE_URL_LEN || !needsParse(pageUrl)) {
    return jsonError('仅支持官方视频平台的页面地址', 400);
  }
  const template = getDanmakuApiTemplate();
  if (!template) return jsonError('服务器未配置弹幕接口（DANMAKU_API）', 501);

  const cacheKey = `danmaku:${pageUrl}`;
  const hit = getCache<DanmakuResponse>(cacheKey);
  if (hit) return respond(hit, 'hit');

  const apiUrl = buildApiUrl(template, pageUrl);
  const verdict = await checkUpstreamAllowed(apiUrl);
  if (!verdict.ok) return jsonError(`弹幕接口地址不可用：${verdict.reason}`, 500);

  let body: unknown;
  try {
    const res = await fetchUpstream(apiUrl, {
      timeoutMs: DANMAKU_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return jsonError(`弹幕接口返回 HTTP ${res.status}`, 502);
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return jsonError('弹幕响应体积异常，已拒绝', 502);
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError('弹幕接口返回的不是 JSON', 502);
    }
  } catch (err) {
    return jsonError(`弹幕接口请求失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }

  const items = normalizeDanmaku(body);
  if (items === null) {
    const msg =
      body && typeof body === 'object' && typeof (body as { msg?: unknown }).msg === 'string'
        ? (body as { msg: string }).msg
        : '弹幕接口未返回弹幕数据';
    return jsonError(`弹幕获取失败：${msg}`, 502);
  }

  const payload: DanmakuResponse = { count: items.length, items };
  setCache(cacheKey, payload, DANMAKU_CACHE_TTL_MS);
  return respond(payload, 'miss');
}
