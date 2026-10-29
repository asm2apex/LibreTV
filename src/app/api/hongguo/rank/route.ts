import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 榜单：real 真人 / comic 漫剧 / ai AI 剧（官网 SSR，需 Googlebot UA） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const raw = new URL(req.url).searchParams.get('key') || 'real';
  const key = (['real', 'comic', 'ai'].includes(raw) ? raw : 'real') as 'real' | 'comic' | 'ai';
  try {
    const items = await hongguoRuntime().web.rank(key);
    return NextResponse.json({ key, items });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '上游请求失败' }, { status: 502 });
  }
}
