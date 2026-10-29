import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 红果首页分栏（官网 SSR 免签） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    const sections = await hongguoRuntime().web.home();
    return NextResponse.json({ sections });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '上游请求失败' }, { status: 502 });
  }
}
