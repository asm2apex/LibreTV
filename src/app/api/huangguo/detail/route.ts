import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getDetail } from '@/lib/huangguo/client';
import { safeToken } from '@/lib/huangguo/projection';

export const runtime = 'nodejs';

/** 剧详情 + 集列表；chapters 的播放 token 只留服务端，不下发 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const id = safeToken(new URL(req.url).searchParams.get('id'));
  if (!id) return NextResponse.json({ error: '剧 id 无效' }, { status: 400 });

  try {
    const d = await getDetail(id);
    return NextResponse.json({
      title: d.title,
      summary: d.summary,
      cover: d.cover,
      totalEp: d.totalEp,
      updateEp: d.updateEp,
      previewEnable: !!d.preview,
      chapters: d.chapters.map((c) => ({ ep: c.ep, title: c.title, mediaTime: c.mediaTime })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
