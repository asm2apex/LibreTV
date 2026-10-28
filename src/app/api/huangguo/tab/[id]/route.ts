import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGet } from '@/lib/huangguo/client';
import { digitsOr, projectList, safeToken } from '@/lib/huangguo/projection';

export const runtime = 'nodejs';

/** 分类 Tab 内容宫格：playlet/home/tab/<id>，pageNumber 翻页 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  if (!safeToken(id)) return NextResponse.json({ error: '分类 id 无效' }, { status: 400 });
  const page = digitsOr(new URL(req.url).searchParams.get('page'), '1');

  try {
    const m = await andGet(`/api/app/playlet/home/tab/${id}?pageNumber=${page}&pageSize=20`);
    return NextResponse.json({
      list: projectList(m, { wholeCoins: true }),
      hasNext: m['hasNext'] === true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
