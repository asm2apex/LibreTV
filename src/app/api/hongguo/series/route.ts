import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 剧详情：App 通道优先（含每集标题/时长），官网 /detail 兜底 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const sid = (new URL(req.url).searchParams.get('series_id') || '').trim();
  if (!sid || !/^\d{1,25}$/.test(sid)) {
    return NextResponse.json({ error: '缺少/非法 series_id' }, { status: 400 });
  }

  const { app, web } = hongguoRuntime();
  if (!app.health.degraded()) {
    try {
      const d = await app.detail(sid);
      return NextResponse.json({
        source: 'app',
        seriesId: d.seriesId,
        title: d.title,
        intro: d.intro,
        cover: d.cover,
        episodeCnt: d.episodeCnt,
        categories: d.categories,
        episodes: d.episodes.map((e) => ({ vid: e.vid, index: e.index, title: e.title, durationSec: e.durationSec })),
      });
    } catch {
      // App 失败 → 官网兜底
    }
  }
  try {
    const d = await web.detail(sid);
    if (!d) return NextResponse.json({ error: '剧不存在' }, { status: 404 });
    return NextResponse.json({
      source: 'web',
      seriesId: d.meta.seriesId,
      title: d.meta.title,
      intro: d.meta.intro ?? '',
      cover: d.meta.cover,
      episodeCnt: d.meta.episodeCnt ?? d.vids.length,
      categories: d.meta.categories ?? [],
      episodes: d.vids.map((vid, i) => ({ vid, index: i + 1, title: null, durationSec: 0 })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '上游请求失败' }, { status: 502 });
  }
}
