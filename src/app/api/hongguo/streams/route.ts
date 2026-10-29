import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 取流档位探测：正常返回签名通道档位列表；降级期只探 360P 公开直链 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const vid = (new URL(req.url).searchParams.get('vid') || '').trim();
  if (!/^\d{5,25}$/.test(vid)) return NextResponse.json({ error: '缺少/非法 vid' }, { status: 400 });

  const { app, web } = hongguoRuntime();
  try {
    if (app.health.degraded()) {
      const pub = await web.probe360p(vid);
      if (pub.ok) {
        return NextResponse.json({ vid, degraded: true, streams: [{ definition: '360p', codec: 'h264', size: pub.size }] });
      }
      return NextResponse.json({ error: '签名通道降级且无公开版', degraded: true }, { status: 503 });
    }
    const streams = await app.resolveStreams(vid);
    return NextResponse.json({
      vid,
      streams: streams.map((s) => ({
        definition: s.definition,
        codec: s.codec,
        size: s.size,
        width: s.width,
        height: s.height,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '上游请求失败' }, { status: 502 });
  }
}
