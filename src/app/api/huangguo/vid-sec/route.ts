import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstream } from '@/lib/fetch-utils';
import { HUANGGUO_API_BASE } from '@/lib/huangguo/client';

export const runtime = 'nodejs';

/** HLS 静态 key 透传（上游该端点不带 auth，与 Go 版一致） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    const res = await fetchUpstream(`${HUANGGUO_API_BASE}/api/app/vid/sec`, { timeoutMs: 10000 });
    if (!res.ok) return NextResponse.json({ error: '上游 key 获取失败' }, { status: 502 });
    const buf = Buffer.from(await res.arrayBuffer());
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: '上游 key 获取失败' }, { status: 502 });
  }
}
