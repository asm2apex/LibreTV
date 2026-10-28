import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGet } from '@/lib/huangguo/client';
import { projectList } from '@/lib/huangguo/projection';

export const runtime = 'nodejs';

/** 黄果站内搜索：playlet/keyword/search */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const kw = (new URL(req.url).searchParams.get('kw') || '').trim().slice(0, 80);
  if (!kw) return NextResponse.json({ list: [] });

  try {
    const m = await andGet(
      `/api/app/playlet/keyword/search?keyword=${encodeURIComponent(kw)}&pageNumber=1&pageSize=20&searchType=all`
    );
    return NextResponse.json({ list: projectList(m) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
