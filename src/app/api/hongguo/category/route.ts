import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 分类页（官网 SSR 免签，slug 翻页） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const q = new URL(req.url).searchParams;
  const slug = (q.get('slug') || 'real-drama').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'real-drama';
  const page = Math.min(500, Math.max(1, Number(q.get('page') || '1') || 1));
  try {
    const r = await hongguoRuntime().web.category(slug, page);
    return NextResponse.json({ slug, page: r.page, totalPages: r.totalPages, items: r.items });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '上游请求失败' }, { status: 502 });
  }
}
