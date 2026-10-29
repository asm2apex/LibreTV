import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 红果搜索：App 签名通道为主，官网 suggestion 兜底（降级期跳过 App） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const q = new URL(req.url).searchParams;
  const query = (q.get('q') || '').trim().slice(0, 80);
  const offset = Math.max(0, Number(q.get('offset') || '0') || 0);
  if (!query) return NextResponse.json({ error: '缺少 q' }, { status: 400 });

  const { app, web } = hongguoRuntime();
  try {
    let items: Array<{ seriesId: string; title: string; cover: string; episodeCnt: number }> = [];
    if (!app.health.degraded()) {
      try {
        items = (await app.search(query, offset)).items;
      } catch {
        // App 失败/空 → suggestion 兜底
      }
    }
    if (items.length === 0) {
      const hits = await web.suggest(query);
      items = hits.map((h) => ({ seriesId: h.seriesId, title: h.title, cover: h.cover, episodeCnt: h.episodeCnt ?? 0 }));
    }
    return NextResponse.json({ query, items });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '上游请求失败' }, { status: 502 });
  }
}
