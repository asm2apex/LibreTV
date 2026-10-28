import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGet } from '@/lib/huangguo/client';
import { getCache, setCache } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

/** 黄果首页分类 Tab 列表（playlet-tab/all） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const cacheKey = 'huangguo:tabs';
  const cached = getCache<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const m = await andGet('/api/app/playlet-tab/all');
    const list: Array<{ id: string; name: string }> = [];
    if (Array.isArray(m['list'])) {
      for (const t of m['list']) {
        if (!t || typeof t !== 'object') continue;
        const o = t as Record<string, unknown>;
        const id = typeof o['id'] === 'string' ? o['id'] : String(o['id'] ?? '');
        const name = typeof o['name'] === 'string' ? o['name'] : '';
        if (id && !/[./]/.test(id)) list.push({ id, name });
      }
    }
    const payload = { list };
    setCache(cacheKey, payload, 5 * 60 * 1000);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
