import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGet } from '@/lib/huangguo/client';
import { projectList } from '@/lib/huangguo/projection';
import { getCache, setCache } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

/** 黄果首页推荐流：playlet-recommend/home/suggestion，seed 游标翻页 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const cursor = new URL(req.url).searchParams.get('cursor') || '';
  if (cursor.length > 256) return NextResponse.json({ error: '游标无效' }, { status: 400 });

  const cacheKey = `huangguo:home:${cursor}`;
  const cached = getCache<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const q = `/api/app/playlet-recommend/home/suggestion?pageSize=12&sortType=0${
      cursor ? `&seed=${encodeURIComponent(cursor)}` : ''
    }`;
    const m = await andGet(q);
    const payload = {
      list: projectList(m, { summary: true }),
      hasNext: m['hasNext'] === true,
      nextCursor: typeof m['nextCursor'] === 'string' ? m['nextCursor'] : '',
    };
    setCache(cacheKey, payload, 60 * 1000);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
