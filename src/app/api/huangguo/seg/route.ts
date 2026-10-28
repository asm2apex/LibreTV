import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstream } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';

export const runtime = 'nodejs';

/**
 * HLS 分片代理：playlist 已本源化，分片 URL 由本路由转发上游 CDN。
 * URL 虽来自服务端改写的 playlist，但路由参数客户端可控 → 必须过 SSRF 校验。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const u = new URL(req.url).searchParams.get('u') || '';
  if (!/^https?:\/\//.test(u) || u.length > 2048) {
    return NextResponse.json({ error: '分片地址无效' }, { status: 400 });
  }
  const verdict = await checkUpstreamAllowed(u);
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 });

  try {
    const res = await fetchUpstream(u, { timeoutMs: 20000 });
    if (!res.ok) return NextResponse.json({ error: `上游 ${res.status}` }, { status: 502 });
    return new Response(res.body, {
      headers: {
        'Content-Type': res.headers.get('content-type') || 'video/mp2t',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: '分片转发失败' }, { status: 502 });
  }
}
