import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { hongguoRuntime } from '@/lib/hongguo/runtime';

export const runtime = 'nodejs';

/** 网关健康：签名通道降级态 + 解密缓存规模（前端降级横幅轮询用） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { app, pipeline } = hongguoRuntime();
  const cache = await pipeline.stats();
  return NextResponse.json({ ok: true, sign: app.health.stats(), streamCache: cache });
}
