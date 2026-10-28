import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGet } from '@/lib/huangguo/client';
import { projectCard, type HgCard } from '@/lib/huangguo/projection';
import { getCache, setCache } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

/**
 * 黄果首页「精选」分栏（App 实测顺序：上新→周榜→剧院→四专题→猜你喜欢）。
 * 模块 moreType 实证：homeModuleType 1=上新 0=周榜 2=剧院；专题=3+sectionId。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const cacheKey = 'huangguo:choose';
  const cached = getCache<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const m = await andGet('/api/app/playlet-recommend/v2/home/choose?layoutVersion=2');

    // choose 的模块/专题条目在 playlets 字段（HomeChoicenessModel.fromJson 实证），不在 list
    const cardsOf = (holder: Record<string, unknown>): HgCard[] => {
      const out: HgCard[] = [];
      if (Array.isArray(holder['playlets'])) {
        for (const it of holder['playlets']) {
          if (it && typeof it === 'object') out.push(projectCard(it as Record<string, unknown>));
        }
      }
      return out;
    };

    const moduleOf = (key: string, moreType: number) => {
      const mm = m[key];
      if (!mm || typeof mm !== 'object') return null;
      const list = cardsOf(mm as Record<string, unknown>);
      if (list.length === 0) return null;
      const mod = mm as Record<string, unknown>;
      return {
        title: typeof mod['title'] === 'string' ? mod['title'] : '',
        desc: typeof mod['desc'] === 'string' ? mod['desc'] : '',
        moreType,
        list,
      };
    };

    const specials: Array<Record<string, unknown> & { list: HgCard[] }> = [];
    let suggest: Record<string, unknown> | null = null;
    if (Array.isArray(m['specialModules'])) {
      for (const x of m['specialModules']) {
        if (!x || typeof x !== 'object') continue;
        const sm = x as Record<string, unknown>;
        const list = cardsOf(sm);
        if (list.length === 0) continue;
        const entry = {
          id: typeof sm['id'] === 'string' ? sm['id'] : '',
          title: typeof sm['title'] === 'string' ? sm['title'] : '',
          desc: typeof sm['desc'] === 'string' ? sm['desc'] : '',
          moreType: 3,
          sectionId: typeof sm['id'] === 'string' ? sm['id'] : '',
          list,
        };
        if (sm['showType'] === 301) suggest = entry; // 猜你喜欢
        else specials.push(entry);
      }
    }

    const payload = {
      modules: [moduleOf('newModule', 1), moduleOf('weekModule', 0), moduleOf('hotModule', 2)].filter(Boolean),
      specials,
      suggest,
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
