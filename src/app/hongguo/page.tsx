'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Header } from '@/components/header';
import { Spinner } from '@/components/states';
import { cn } from '@/lib/utils';

const HongguoPlayer = dynamic(() => import('@/components/hongguo-player').then((m) => m.HongguoPlayer), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-[70] bg-black flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});

/**
 * 红果短剧 tab 页（移植自 hongguo web 前端）：
 * 榜单（真人/漫剧/AI）+ 分类宫格（官网免签 SSR）+ 搜索 + 剧详情 + MP4 播放器。
 * 点卡片进详情页（分集列表 + 继续播放），点集进播放器。
 */

interface SeriesItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeCnt?: number;
  hot?: string;
  intro?: string;
  categories?: string[];
  rank?: number;
}

interface CategoryResp {
  slug: string;
  page: number;
  totalPages: number;
  items: SeriesItem[];
}

interface SeriesDetail {
  source: 'app' | 'web';
  seriesId: string;
  title: string;
  intro: string;
  cover: string;
  episodeCnt: number;
  categories: string[];
  episodes: Array<{ vid: string; index: number; title: string | null; durationSec: number }>;
}

const CATS: Array<[string, string]> = [
  ['real-drama', '短剧'],
  ['comic-drama', '漫剧'],
  ['comic', '漫画'],
  ['ai-drama', 'AI 剧'],
];

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function subOf(it: SeriesItem): string {
  return it.hot || (it.episodeCnt ? `${it.episodeCnt} 集` : '');
}

function Card({ item, withRank, onOpen }: { item: SeriesItem; withRank?: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      className="text-left rounded-xl overflow-hidden bg-surface-raised border border-line hover:border-muted transition-colors"
      onClick={() => onOpen(item.seriesId)}
    >
      <div className="relative w-full aspect-[3/4] bg-surface overflow-hidden">
        {/* 红果封面为官网直链，须带 no-referrer 防盗链 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.cover}
          alt={item.title}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          onError={(e) => {
            e.currentTarget.style.opacity = '0.15';
          }}
        />
        {withRank && item.rank ? (
          <span className="absolute top-0 left-0 min-w-6 px-1.5 py-0.5 bg-red-600 text-white text-xs font-bold rounded-br-lg">
            {item.rank}
          </span>
        ) : null}
      </div>
      <div className="px-2 py-1.5">
        <b className="block text-xs font-semibold leading-snug line-clamp-2">{item.title}</b>
        <span className="block mt-0.5 text-[11px] text-muted truncate">{subOf(item)}</span>
      </div>
    </button>
  );
}

function CardGrid({ list, withRank, onOpen }: { list: SeriesItem[]; withRank?: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 px-4 pt-3">
      {list.map((it) => (
        <Card key={it.seriesId} item={it} withRank={withRank} onOpen={onOpen} />
      ))}
    </div>
  );
}

type View =
  | { type: 'rank'; key: 'real' | 'comic' | 'ai' }
  | { type: 'category' }
  | { type: 'search'; q: string }
  | { type: 'detail'; sid: string };

export default function HongguoPage() {
  const [view, setView] = useState<View>({ type: 'rank', key: 'real' });
  const [rankItems, setRankItems] = useState<SeriesItem[] | null>(null);
  const [rankError, setRankError] = useState('');
  const [catSlug, setCatSlug] = useState('real-drama');
  const [cat, setCat] = useState<{ items: SeriesItem[]; page: number; totalPages: number } | null>(null);
  const [catLoading, setCatLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<SeriesItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [kw, setKw] = useState('');
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [play, setPlay] = useState<{ startIndex: number } | null>(null);
  const [degraded, setDegraded] = useState(false);

  // 签名通道健康轮询：降级横幅（60s 一次）
  useEffect(() => {
    const check = () =>
      getJSON<{ sign?: { degraded?: boolean } }>('/api/hongguo/health')
        .then((h) => setDegraded(!!h.sign?.degraded))
        .catch(() => {});
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);

  // 榜单
  useEffect(() => {
    if (view.type !== 'rank') return;
    setRankItems(null);
    setRankError('');
    getJSON<{ items: SeriesItem[] }>(`/api/hongguo/rank?key=${view.key}`)
      .then((d) => setRankItems(d.items))
      .catch((e: unknown) => setRankError(e instanceof Error ? e.message : '加载失败'));
  }, [view]);

  // 分类（含重试一次——上游 SSR 偶发空响应）
  const loadCategory = useCallback(
    async (slug: string, page: number, append: boolean) => {
      setCatLoading(true);
      try {
        const d = await getJSON<CategoryResp>(`/api/hongguo/category?slug=${slug}&page=${page}`);
        if (!d.items.length && page === 1 && !append) {
          // 上游抖动，静默重试一次
          const d2 = await getJSON<CategoryResp>(`/api/hongguo/category?slug=${slug}&page=1`);
          setCat({ items: d2.items, page: 1, totalPages: d2.totalPages });
        } else {
          setCat((prev) =>
            append && prev
              ? { items: [...prev.items, ...d.items], page: d.page, totalPages: d.totalPages }
              : { items: d.items, page: d.page, totalPages: d.totalPages }
          );
        }
      } catch {
        setCat(append ? cat : { items: [], page: 0, totalPages: 0 });
      } finally {
        setCatLoading(false);
      }
    },
    [cat]
  );

  useEffect(() => {
    if (view.type !== 'category') return;
    loadCategory(catSlug, 1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.type, catSlug]);

  // 详情
  useEffect(() => {
    if (view.type !== 'detail') return;
    setDetail(null);
    setDetailLoading(true);
    getJSON<SeriesDetail>(`/api/hongguo/series?series_id=${view.sid}`)
      .then(setDetail)
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [view]);

  const openSeries = (sid: string) => setView({ type: 'detail', sid });

  const doSearch = async () => {
    const q = kw.trim();
    if (!q) return;
    setView({ type: 'search', q });
    setSearching(true);
    setSearchResult(null);
    try {
      const d = await getJSON<{ items: SeriesItem[] }>(`/api/hongguo/search?q=${encodeURIComponent(q)}`);
      setSearchResult(d.items);
    } catch {
      setSearchResult([]);
    } finally {
      setSearching(false);
    }
  };

  // 继续播放：最近看过的集
  const resumeOf = (d: SeriesDetail): { idx: number; label: string } | null => {
    try {
      const seen = JSON.parse(localStorage.getItem(`hongguo:seen:${d.seriesId}`) || '{}') as Record<string, number>;
      const latest = Object.entries(seen).sort((a, b) => b[1] - a[1]);
      for (const [vid] of latest) {
        const i = d.episodes.findIndex((e) => e.vid === vid);
        if (i >= 0) {
          const p = JSON.parse(localStorage.getItem(`hongguo:prog:${d.seriesId}:${vid}`) || 'null') as { t?: number } | null;
          const mm = p && p.t && p.t > 5 ? `（看到 ${fmtTime(p.t)}）` : '';
          return { idx: i, label: `▶ 继续播放 · 第 ${i + 1} 集${mm}` };
        }
      }
    } catch { /* 忽略 */ }
    return null;
  };

  const content = (() => {
    if (view.type === 'detail') {
      if (detailLoading && !detail) {
        return (
          <div className="py-10 flex justify-center">
            <Spinner />
          </div>
        );
      }
      if (!detail) return <div className="py-10 text-center text-sm text-muted">详情加载失败，请返回重试</div>;
      const seen = (() => {
        try {
          return JSON.parse(localStorage.getItem(`hongguo:seen:${detail.seriesId}`) || '{}') as Record<string, number>;
        } catch {
          return {};
        }
      })();
      const resume = resumeOf(detail);
      return (
        <div className="px-4 pt-3 pb-8">
          <div className="flex gap-4">
            <div className="w-28 shrink-0">
              <div className="w-full aspect-[3/4] rounded-xl overflow-hidden bg-surface-raised border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detail.cover}
                  alt={detail.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.opacity = '0.15';
                  }}
                />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold leading-snug">{detail.title}</h1>
              <div className="mt-1 text-xs text-muted">
                {detail.episodeCnt} 集 · {detail.source === 'web' ? '官网源（分集无时长）' : 'App 源'}
              </div>
              {detail.categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {detail.categories.map((c) => (
                    <span key={c} className="chip bg-surface-raised border border-line">
                      {c}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-muted leading-relaxed line-clamp-4">{detail.intro}</p>
            </div>
          </div>
          {resume && (
            <button
              className="mt-4 w-full py-3 rounded-xl bg-accent text-on-accent text-sm font-semibold"
              onClick={() => setPlay({ startIndex: resume.idx })}
            >
              {resume.label}
            </button>
          )}
          <div className="grid grid-cols-5 sm:grid-cols-8 gap-2 mt-4">
            {detail.episodes.map((e, i) => (
              <button
                key={e.vid}
                className={cn(
                  'rounded-lg py-2.5 text-sm border transition-colors',
                  seen[e.vid]
                    ? 'bg-surface-raised border-amber-700/50 text-amber-500'
                    : 'bg-surface-raised border-line hover:border-muted'
                )}
                onClick={() => setPlay({ startIndex: i })}
              >
                {e.index}
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (view.type === 'search') {
      return (
        <div>
          {searching && (
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          )}
          {!searching && searchResult && searchResult.length === 0 && (
            <div className="py-10 text-center text-sm text-muted">无结果</div>
          )}
          {!searching && searchResult && searchResult.length > 0 && <CardGrid list={searchResult} onOpen={openSeries} />}
        </div>
      );
    }
    if (view.type === 'category') {
      return (
        <div>
          <div className="flex gap-2 px-4 pt-3 overflow-x-auto no-scrollbar">
            {CATS.map(([s, n]) => (
              <button
                key={s}
                className={cn(
                  'chip border',
                  s === catSlug ? 'border-accent text-accent' : 'border-line text-muted'
                )}
                onClick={() => setCatSlug(s)}
              >
                {n}
              </button>
            ))}
          </div>
          {catLoading && !cat?.items.length && (
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          )}
          {cat && cat.items.length > 0 && <CardGrid list={cat.items} onOpen={openSeries} />}
          {cat && cat.items.length === 0 && !catLoading && (
            <div className="py-10 text-center text-sm text-muted">此分类暂无内容</div>
          )}
          {cat && cat.page < cat.totalPages && (
            <div className="py-5 text-center">
              <button className="btn text-sm" disabled={catLoading} onClick={() => loadCategory(catSlug, cat.page + 1, true)}>
                {catLoading ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </div>
      );
    }
    // rank
    return (
      <div>
        {rankError && <div className="py-10 text-center text-sm text-muted">{rankError}</div>}
        {!rankError && !rankItems && (
          <div className="py-10 flex justify-center">
            <Spinner />
          </div>
        )}
        {rankItems && rankItems.length === 0 && <div className="py-10 text-center text-sm text-muted">榜单为空</div>}
        {rankItems && rankItems.length > 0 && <CardGrid list={rankItems} withRank onOpen={openSeries} />}
      </div>
    );
  })();

  return (
    <div className="min-h-screen bg-surface text-content">
      <Header />
      {degraded && (
        <div className="bg-amber-900/40 border-b border-amber-700/50 text-amber-300 text-xs px-4 py-2 text-center">
          签名通道降级中：新集播放可能回落 360P 公开版，已缓存的集不受影响
        </div>
      )}
      <div className="max-w-6xl mx-auto px-4 pt-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            doSearch();
          }}
        >
          <input
            className="input flex-1 h-9"
            placeholder="搜索红果短剧…"
            value={kw}
            maxLength={80}
            onChange={(e) => setKw(e.target.value)}
          />
          <button type="submit" className="btn h-9 px-4 text-sm" disabled={searching}>
            搜索
          </button>
        </form>
      </div>
      {/* 子 Tab：榜单三类 + 分类 */}
      <div className="sticky top-14 z-30 bg-surface/90 backdrop-blur border-b border-line mt-3">
        <div className="max-w-6xl mx-auto flex gap-1 px-4 py-1.5 overflow-x-auto no-scrollbar">
          {(
            [
              ['real', '真人榜'],
              ['comic', '漫剧榜'],
              ['ai', 'AI 剧'],
            ] as const
          ).map(([k, n]) => (
            <button
              key={k}
              className={cn(
                'relative shrink-0 px-3 py-2 text-sm transition-colors',
                view.type === 'rank' && view.key === k ? 'text-content font-bold' : 'text-muted hover:text-content'
              )}
              onClick={() => setView({ type: 'rank', key: k })}
            >
              {n}
              {view.type === 'rank' && view.key === k && (
                <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 w-4 h-[3px] rounded bg-accent" />
              )}
            </button>
          ))}
          <button
            className={cn(
              'relative shrink-0 px-3 py-2 text-sm transition-colors',
              view.type === 'category' ? 'text-content font-bold' : 'text-muted hover:text-content'
            )}
            onClick={() => setView({ type: 'category' })}
          >
            分类
            {view.type === 'category' && (
              <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 w-4 h-[3px] rounded bg-accent" />
            )}
          </button>
        </div>
      </div>
      <main className="max-w-6xl mx-auto">{content}</main>
      {detail && play && (
        <HongguoPlayer
          seriesId={detail.seriesId}
          title={detail.title}
          episodes={detail.episodes}
          startIndex={play.startIndex}
          onClose={() => setPlay(null)}
        />
      )}
    </div>
  );
}

function fmtTime(sec: number): string {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
