import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';
import { fileRangeResponse } from '@/lib/hongguo/serve';

export const runtime = 'nodejs';

/**
 * 解密流下发（Range 206 MP4）：
 * 1) 缓存命中直接 Range 回源文件
 * 2) 缓存未命中 → resolveStreams 选档 → 下载密文 → spade 派生 key → CENC 逐样本
 *    解密 → 剥壳落盘 → Range 下发（同集并发去重）
 * 3) 签名通道不可用 → 反代官网 360P 公开直链（免签免解密，Range 透传）
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const q = new URL(req.url).searchParams;
  const vid = (q.get('vid') || '').trim();
  if (!/^\d{5,25}$/.test(vid)) {
    return NextResponse.json({ error: '缺少/非法 vid' }, { status: 400 });
  }
  const quality = (q.get('q') || '1080p').replace(/[^a-z0-9]/gi, '').slice(0, 8) || '1080p';

  const { app, web, pipeline } = hongguoRuntime();

  // 1) 缓存命中（降级期已下载的集不受影响）
  const cached = await pipeline.readDecrypted(vid, quality).catch(() => null);
  if (cached) {
    return fileRangeResponse(pipeline.cachePathOf(vid, quality), cached.length, req, 'video/mp4', `${vid}.mp4`);
  }

  try {
    // 2) 签名通道取流 → 解密管线
    const streams = await app.resolveStreams(vid);
    const pick = streams.find((s) => s.definition === quality) ?? streams[0]!;
    const file = await pipeline.ensureDecrypted(vid, pick.definition, async () => pick);
    const s = await stat(file);
    return fileRangeResponse(file, s.size, req, 'video/mp4', `${vid}.mp4`);
  } catch {
    // 3) 降级兜底：官网 360P 公开直链反代（Range 透传）
    const probe = await web.probe360p(vid);
    if (!probe.ok) {
      return NextResponse.json({ error: '取流失败且无公开版' }, { status: 503 });
    }
    const range = req.headers.get('range');
    const upstream = await fetch(probe.url, {
      headers: {
        'User-Agent': 'com.phoenix.read/71332',
        Referer: 'https://hongguoduanju.com/',
        ...(range ? { Range: range } : {}),
      },
      redirect: 'follow',
    });
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: `公开直链 ${upstream.status}` }, { status: 502 });
    }
    const headers = new Headers({
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    for (const k of ['content-length', 'content-range']) {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }
}
