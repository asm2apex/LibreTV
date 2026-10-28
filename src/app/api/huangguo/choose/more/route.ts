import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGet } from '@/lib/huangguo/client';
import { digitsOr, projectList, safeToken } from '@/lib/huangguo/projection';

export const runtime = 'nodejs';

/** 精选模块「更多」页：homeModuleType + pageNumber；专题 sid=sectionId */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const sp = new URL(req.url).searchParams;
  const type = digitsOr(sp.get('type'), '0');
  const page = digitsOr(sp.get('page'), '1');
  const sidRaw = sp.get('sid') || '';
  const sid = sidRaw ? safeToken(sidRaw) : '';
  if (sidRaw && !sid) return NextResponse.json({ error: '专题 id 无效' }, { status: 400 });

  try {
    let q = `/api/app/playlet-recommend/v2/home/choose/detail?layoutVersion=2&homeModuleType=${type}&pageNumber=${page}&pageSize=30`;
    if (sid) q += `&sectionId=${encodeURIComponent(sid)}`;
    const m = await andGet(q);
    return NextResponse.json({ list: projectList(m), hasNext: m['hasNext'] === true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
