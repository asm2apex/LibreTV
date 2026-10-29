// 官网 web 源客户端（免签目录/搜索/榜单 + 360P 公开直链探测）。
// 规格：docs/protocol/02-api-and-decryption.md §1.1、§2、§9.1。
// 2026-10-25 实测状态（规格 §10.9 之外的新漂移，已实测确认）：
//   /detail?series_id=    存活（seriesDetail + vid_list + accessible_episode_cnt）
//   /incent_resource/suggestion  存活（免签搜索，返回精确匹配 + video_data）
//   /  /rank/*            存活（SSR；rank 需 Googlebot UA，数据在 loaderData 的路由键下）
//   /search/{kw}          已死（页面无 _ROUTER_DATA，纯客户端渲染）——搜索走 suggestion
//   /player/{sid}         已死（200 + 0 字节）——vid_list 改走 /detail

import { cleanUrl, fetchWithRetry, Throttle, UA_DESKTOP, UA_GOOGLEBOT } from '../util/http';
import { extractRouterData, parseJsonLoose } from '../util/router-data';
import { TtlCache } from '../util/cache';

const BASE = 'https://hongguoduanju.com';

export interface WebSeries {
  seriesId: string;
  title: string;
  cover: string;
  intro?: string;
  episodeCnt?: number;
  hot?: string;
  categories?: string[];
  rank?: number;
}

export interface WebDetail {
  meta: WebSeries;
  vids: string[];
  accessibleEpisodeCnt: number;
  payType: number;
}

function deskHeaders(): Record<string, string> {
  return {
    'User-Agent': UA_DESKTOP,
    Referer: `${BASE}/`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
}

function botHeaders(): Record<string, string> {
  return { 'User-Agent': UA_GOOGLEBOT, 'Accept-Language': 'zh-CN,zh;q=0.9' };
}

// 卡片字段映射（home/suggestion 用 snake_case；rank 条目实测为 camelCase——
// seriesId/title/cover，2026-10-25 实测，两形态都兼容）
function mapCard(v: Record<string, unknown>): WebSeries | null {
  const sid = v['series_id'] ?? v['seriesId'];
  if (sid === undefined || sid === null) return null;
  return {
    seriesId: String(sid),
    title: String(v['series_title'] ?? v['series_name'] ?? v['title'] ?? v['name'] ?? ''),
    cover: cleanUrl(String(v['series_cover'] ?? v['cover'] ?? '')),
    intro: typeof v['series_intro'] === 'string' ? v['series_intro'] : undefined,
    episodeCnt: num(v['episode_cnt']),
    hot: typeof v['hot_score_data'] === 'object' && v['hot_score_data'] !== null
      ? String((v['hot_score_data'] as Record<string, unknown>)['text'] ?? '')
      : undefined,
    categories: Array.isArray(v['category_list'])
      ? (v['category_list'] as Array<Record<string, unknown>>).map((c) => String(c['name'])).filter(Boolean)
      : undefined,
    rank: num(v['rank']) ?? undefined,
  };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? n : undefined;
}

const CATEGORY_SLUGS = new Set([
  'real-drama', 'comic-drama', 'comic', 'ai-drama',
  // 24 主题 slug（tvbox:3681-3714）——白名单校验用，防路径注入
  'urban', 'romance', 'fantasy', 'costume', 'rebirth', 'counterattack',
  'sweet', 'revenge', 'god-of-war', 'boss', 'master', 'rich-family',
  'marriage', 'baby', 'medical', 'suspen', 'horror', 'comedy',
  'rural', 'war', 'special-topic', 'police', 'legend', 'youth',
]);

export class WebSource {
  // 目录数据分钟级稳定：TTL 缓存削上游压力（官网对突发软限流，簇状失败实测）；
  // 节流 600ms（danmu 实证档位 600+rand(400) 的基线）
  private readonly throttle = new Throttle(600);
  private readonly cache = new TtlCache<unknown>(5 * 60_000, 256);

  private cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== null) return Promise.resolve(hit as T);
    return loader().then((v) => {
      // 空结果（含空数组/null）不缓存：上游抖动不该被记住
      const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
      if (!empty) this.cache.set(key, v);
      return v;
    });
  }

  /**
   * 官网页面获取 + UA 竞速回退：SSR 对 UA 间歇性门控 + undici 连接池偶发
   * `terminated`（服务端掐空闲连接的竞态，实测约 1/10）。逐 UA 尝试，每次尝试
   * 覆盖 fetch+text+解析全程（text 中途断流也要落到下一尝试而非炸出调用链），
   * 由 hasContent 判定有效性，间隔 350ms。
   */
  private async fetchRouterData(
    url: string,
    uaOrder: Array<() => Record<string, string>>,
    hasContent: (data: unknown) => boolean,
  ): Promise<Record<string, unknown> | null> {
    for (const mk of uaOrder) {
      await this.throttle.acquire();
      try {
        const res = await fetchWithRetry(url, { headers: mk(), retries: 1 });
        if (!res.ok) continue;
        const data = extractRouterData(await res.text()) as unknown;
        if (data && typeof data === 'object' && hasContent(data)) return data as Record<string, unknown>;
      } catch {
        // 网络层失败（含 text 中断流）：落入下一组 UA
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    return null;
  }

  /**
   * 分类页（免签 SSR）。2026-10-25 实测：page=1 必须省略 ?page 参数（带参数 301
   * 到无参数版），page≥2 可直连；数据在 loaderData 任意含 recommendList 的键下，
   * 条目为 snake_case（与 rank 的 camelCase 不同，mapCard 双形态兼容）。
   */
  async category(slug: string, page = 1): Promise<{ items: WebSeries[]; page: number; totalPages: number }> {
    if (!CATEGORY_SLUGS.has(slug)) return { items: [], page, totalPages: 0 };
    return this.cached(`cat:${slug}:${page}`, () => this.rawCategory(slug, page));
  }

  private async rawCategory(slug: string, page: number): Promise<{ items: WebSeries[]; page: number; totalPages: number }> {
    const url = page > 1 ? `${BASE}/category/${slug}?page=${page}` : `${BASE}/category/${slug}`;
    const data = await this.fetchRouterData(url, [deskHeaders, botHeaders], (d) => {
      const loader = (d as Record<string, unknown>)['loaderData'];
      if (!loader || typeof loader !== 'object') return false;
      return Object.values(loader as Record<string, unknown>).some(
        (v) => v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)['recommendList']),
      );
    });
    if (!data) return { items: [], page, totalPages: 0 };
    const loader = data['loaderData'] as Record<string, unknown>;
    for (const v of Object.values(loader)) {
      if (!v || typeof v !== 'object') continue;
      const obj = v as Record<string, unknown>;
      const list = obj['recommendList'];
      const pg = obj['pagination'] as Record<string, unknown> | undefined;
      if (Array.isArray(list)) {
        const items = (list as Array<Record<string, unknown>>)
          .map(mapCard)
          .filter((x): x is WebSeries => x !== null);
        return { items, page: Number(pg?.['pageNum']) || page, totalPages: Number(pg?.['totalPages']) || 0 };
      }
    }
    return { items: [], page, totalPages: 0 };
  }

  /** 免签搜索：suggestion 接口（keyword 为纯数字且 ≥10 位时是剧集 ID，可再拉 detail 补全）。 */
  async suggest(query: string, count = 20): Promise<WebSeries[]> {
    return this.cached(`suggest:${query}:${count}`, () => this.rawSuggest(query, count));
  }

  private async rawSuggest(query: string, count: number): Promise<WebSeries[]> {
    await this.throttle.acquire();
    const url = `${BASE}/incent_resource/suggestion?app_id=8662&web_id=7300000000000000000&query=${encodeURIComponent(query)}&count=${count}`;
    try {
      const res = await fetchWithRetry(url, { headers: deskHeaders(), retries: 2 });
      if (!res.ok) return [];
      const data = parseJsonLoose(await res.text()) as Record<string, unknown>;
      const list = data['suggest_list'];
      if (!Array.isArray(list)) return [];
      const out: WebSeries[] = [];
      for (const it of list as Array<Record<string, unknown>>) {
        const vd = it['video_data'];
        if (vd && typeof vd === 'object') {
          const card = mapCard(vd as Record<string, unknown>);
          // suggestion 的 keyword 字段在精确匹配时是剧集 ID
          if (card && card.seriesId === '0' && /^\d{10,}$/.test(String(it['keyword'] ?? ''))) {
            card.seriesId = String(it['keyword']);
          }
          if (card) out.push(card);
        }
      }
      return out;
    } catch {
      return []; // 含 text() 中断流：调用方（搜索兜底链）不再收到异常
    }
  }

  /** 剧集详情 + 全量 vid 列表。 */
  async detail(seriesId: string): Promise<WebDetail | null> {
    return this.cached(`detail:${seriesId}`, () => this.rawDetail(seriesId));
  }

  private async rawDetail(seriesId: string): Promise<WebDetail | null> {
    await this.throttle.acquire();
    let text: string | null = null;
    try {
      const res = await fetchWithRetry(`${BASE}/detail?series_id=${seriesId}`, {
        headers: deskHeaders(),
        retries: 2,
      });
      if (res.ok) text = await res.text();
    } catch {
      return null;
    }
    if (text === null) return null;
    const data = extractRouterData(text) as Record<string, unknown> | null;
    const loader = data?.['loaderData'] as Record<string, unknown> | undefined;
    const page = loader?.['detail_page'] as Record<string, unknown> | undefined;
    const sd = page?.['seriesDetail'] as Record<string, unknown> | undefined;
    if (!sd) return null;
    const vids = Array.isArray(sd['vid_list']) ? (sd['vid_list'] as unknown[]).map(String) : [];
    return {
      meta: {
        seriesId: String(sd['series_id'] ?? seriesId),
        title: String(sd['series_name'] ?? ''),
        cover: cleanUrl(String(sd['series_cover'] ?? '')),
        intro: typeof sd['series_intro'] === 'string' ? sd['series_intro'] : undefined,
        episodeCnt: num(sd['episode_cnt']),
        categories: Array.isArray(sd['tags'])
          ? (sd['tags'] as Array<Record<string, unknown>>).map((t) => String(t['name'] ?? t)).filter(Boolean)
          : undefined,
      },
      vids,
      accessibleEpisodeCnt: num(sd['accessible_episode_cnt']) ?? 0,
      payType: num(sd['pay_type']) ?? 0,
    };
  }

  /** 首页分区。 */
  async home(): Promise<Array<{ title: string; items: WebSeries[] }>> {
    return this.cached('home', () => this.rawHome());
  }

  private async rawHome(): Promise<Array<{ title: string; items: WebSeries[] }>> {
    await this.throttle.acquire();
    const res = await fetchWithRetry(`${BASE}/`, { headers: deskHeaders(), retries: 2 });
    const data = extractRouterData(await res.text()) as Record<string, unknown> | null;
    const page = (data?.['loaderData'] as Record<string, unknown> | undefined)?.['page'] as
      | Record<string, unknown>
      | undefined;
    const sections = page?.['homeSections'];
    if (!Array.isArray(sections)) return [];
    const out: Array<{ title: string; items: WebSeries[] }> = [];
    for (const sec of sections as Array<Record<string, unknown>>) {
      const items = Array.isArray(sec['video_list'])
        ? (sec['video_list'] as Array<Record<string, unknown>>).map(mapCard).filter((x): x is WebSeries => x !== null)
        : [];
      out.push({ title: String(sec['section_title'] ?? sec['title'] ?? ''), items });
    }
    return out;
  }

  /**
   * 榜单。key ∈ real | comic | ai。必须 Googlebot UA（规格 02 §1.1）；
   * 数据在 loaderData 的路由键（如 rank_hot-real-drama/page）下。同样走 UA 竞速回退。
   */
  async rank(key: 'real' | 'comic' | 'ai'): Promise<WebSeries[]> {
    return this.cached(`rank:${key}`, () => this.rawRank(key));
  }

  private async rawRank(key: 'real' | 'comic' | 'ai'): Promise<WebSeries[]> {
    const data = await this.fetchRouterData(`${BASE}/rank/hot-${key}-drama`, [botHeaders, deskHeaders], (d) => {
      const loader = (d as Record<string, unknown>)['loaderData'];
      if (!loader || typeof loader !== 'object') return false;
      return Object.entries(loader as Record<string, unknown>).some(
        ([k, v]) => /^rank_/.test(k) && v && typeof v === 'object' &&
          Array.isArray(
            (v as Record<string, unknown>)['rankList'] ??
              ((v as Record<string, unknown>)['content'] as Record<string, unknown> | undefined)?.['rankList'],
          ),
      );
    });
    if (!data) return [];
    const loader = data['loaderData'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(loader)) {
      if (!/^rank_/.test(k) || v === null || typeof v !== 'object') continue;
      const obj = v as Record<string, unknown>;
      const rankList = ((obj['content'] as Record<string, unknown> | undefined)?.['rankList'] ?? obj['rankList']);
      if (Array.isArray(rankList)) {
        return (rankList as Array<Record<string, unknown>>).map(mapCard).filter((x): x is WebSeries => x !== null);
      }
    }
    return [];
  }

  /** 免费集 360P 公开直链探测（免签免解密的兜底线路，规格 02 §1.1 末行）。 */
  async probe360p(vid: string): Promise<{ ok: boolean; url: string; size?: number }> {
    const url = `${BASE}/video/public/${vid}/360p.mp4`;
    try {
      const res = await fetchWithRetry(url, { headers: deskHeaders(), method: 'HEAD', retries: 1 });
      if (res.ok) {
        return { ok: true, url, size: Number(res.headers.get('content-length')) || undefined };
      }
      return { ok: false, url };
    } catch {
      return { ok: false, url };
    }
  }
}
