'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Header } from '@/components/header';
import { Spinner } from '@/components/states';
import { cn } from '@/lib/utils';
import type { HgCard } from '@/lib/huangguo/projection';

const HuangguoPlayer = dynamic(() => import('@/components/huangguo-player').then((m) => m.HuangguoPlayer), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-[70] bg-black flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});

/**
 * 黄果短剧 tab 页：精选（上新/周榜/剧院/专题/猜你喜欢）+ 分类宫格 + 站内搜索。
 * 点卡片直接进竖屏播放器（App 同款交互：有预告先播预告）。
 * 翻页由 Sentinel 触底驱动，ref 防重入（不靠 effect 自增，避免全量预取循环）。
 */

interface ChooseModule {
  title: string;
  desc: string;
  moreType: number;
  /** 专题条目带 sectionId（「全部」页查询用）；普通模块无 */
  sectionId?: string;
  list: HgCard[];
}
interface ChooseSpecial extends ChooseModule {
  id: string;
  sectionId: string;
}
interface ChoosePayload {
  modules: ChooseModule[];
  specials: ChooseSpecial[];
  suggest: ChooseSpecial | null;
}
interface PageState {
  list: HgCard[];
  next: number | null; // 下一页页码；null = 没有更多
  busy: boolean;
  error: boolean;
}

const EMPTY_PAGE: PageState = { list: [], next: 1, busy: false, error: false };

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function epMeta(c: HgCard): string {
  const tot = c.totalEpisode || 0;
  const upd = c.updateEpisode || 0;
  return tot > 1 ? `全${tot}集${tot > upd ? ` · 更新至${upd}` : ''}` : '单集';
}

function HgCardView({ card, onPlay }: { card: HgCard; onPlay: (id: string) => void }) {
  return (
    <button
      className="text-left rounded-xl overflow-hidden bg-surface-raised border border-line hover:border-muted transition-colors"
      onClick={() => onPlay(card.id)}
    >
      <div className="w-full aspect-[3/4] bg-surface overflow-hidden">
        {/* 黄果封面必须走本源 XOR 代理，不能直连 CDN */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/huangguo/img/${card.cover}`}
          alt={card.title}
          loading="lazy"
          className="w-full h-full object-cover"
        />
      </div>
      <div className="px-2 py-1.5">
        <b className="block text-xs font-semibold leading-snug line-clamp-2">{card.title}</b>
        <span className="block mt-0.5 text-[11px] text-muted">{epMeta(card)}</span>
      </div>
    </button>
  );
}

/** 触底加载哨兵：独立顶层组件（内嵌定义会导致每次渲染重挂载、observer 抖动） */
function Sentinel({ onHit, active }: { onHit: () => void; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const hitRef = useRef(onHit);
  hitRef.current = onHit;
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) hitRef.current();
      },
      { rootMargin: '400px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return <div ref={ref} className="h-1" aria-hidden />;
}

function CardGrid({ list, onPlay, dense }: { list: HgCard[]; onPlay: (id: string) => void; dense?: boolean }) {
  return (
    <div
      className={cn(
        'grid gap-3 px-4 pt-3 pb-1',
        dense ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
      )}
    >
      {list.map((c) => (
        <HgCardView key={c.id} card={c} onPlay={onPlay} />
      ))}
    </div>
  );
}

function SubTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        'relative shrink-0 px-3 py-2 text-sm transition-colors',
        active ? 'text-content font-bold' : 'text-muted hover:text-content'
      )}
      onClick={onClick}
    >
      {label}
      {active && <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 w-4 h-[3px] rounded bg-accent" />}
    </button>
  );
}

function BackRow({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1">
      <button className="w-8 h-8 -ml-1 text-muted hover:text-content text-xl leading-none" onClick={onBack} aria-label="返回">
        ‹
      </button>
      <span className="text-[15px] font-bold truncate">{title}</span>
    </div>
  );
}

export default function HuangguoPage() {
  const [tabs, setTabs] = useState<Array<{ id: string; name: string }>>([]);
  const [activeTab, setActiveTab] = useState('__chosen__'); // 精选置首（App 实证）
  const [choose, setChoose] = useState<ChoosePayload | null>(null);
  const [chooseError, setChooseError] = useState('');
  const [cat, setCat] = useState<PageState>(EMPTY_PAGE); // 分类宫格
  const [more, setMore] = useState<{ title: string; type: string; sid: string } | null>(null);
  const [morePage, setMorePage] = useState<PageState>(EMPTY_PAGE); // 模块更多页
  const [kw, setKw] = useState('');
  const [searchResult, setSearchResult] = useState<HgCard[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  // 分类加载：页码/忙态放 ref（setState updater 必须纯净，不能用 throw 做守卫）
  const catRef = useRef<{ next: number | null; busy: boolean }>({ next: 1, busy: false });
  const loadCat = useCallback(async (tabId: string) => {
    const st = catRef.current;
    if (st.busy || st.next == null) return;
    const page = st.next;
    catRef.current = { next: st.next, busy: true };
    setCat((s) => ({ ...s, busy: true }));
    try {
      const d = await getJSON<{ list: HgCard[]; hasNext: boolean }>(`/api/huangguo/tab/${tabId}?page=${page}`);
      catRef.current = { next: d.hasNext ? page + 1 : null, busy: false };
      setCat((s) => ({
        list: page === 1 ? d.list : [...s.list, ...d.list],
        next: d.hasNext ? page + 1 : null,
        busy: false,
        error: false,
      }));
    } catch {
      catRef.current = { next: page, busy: false };
      setCat((s) => ({ ...s, busy: false, error: true }));
    }
  }, []);

  const moreRef = useRef<{ next: number | null; busy: boolean }>({ next: 1, busy: false });
  const loadMoreList = useCallback(async (m: { title: string; type: string; sid: string }) => {
    const st = moreRef.current;
    if (st.busy || st.next == null) return;
    const page = st.next;
    moreRef.current = { next: st.next, busy: true };
    setMorePage((s) => ({ ...s, busy: true }));
    try {
      const d = await getJSON<{ list: HgCard[]; hasNext: boolean }>(
        `/api/huangguo/choose/more?type=${m.type}&page=${page}&sid=${m.sid}`
      );
      moreRef.current = { next: d.hasNext ? page + 1 : null, busy: false };
      setMorePage((s) => ({
        list: page === 1 ? d.list : [...s.list, ...d.list],
        next: d.hasNext ? page + 1 : null,
        busy: false,
        error: false,
      }));
    } catch {
      moreRef.current = { next: page, busy: false };
      setMorePage((s) => ({ ...s, busy: false, error: true }));
    }
  }, []);

  useEffect(() => {
    getJSON<{ list: Array<{ id: string; name: string }> }>('/api/huangguo/tabs')
      .then((d) => setTabs(d.list))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (choose || chooseError) return;
    getJSON<ChoosePayload>('/api/huangguo/choose')
      .then(setChoose)
      .catch((e: unknown) => setChooseError(e instanceof Error ? e.message : '加载失败'));
  }, [choose, chooseError]);

  // 切分类：重置 ref/state 后取第一页
  useEffect(() => {
    if (activeTab === '__chosen__') return;
    catRef.current = { next: 1, busy: false };
    setCat(EMPTY_PAGE);
    const t = setTimeout(() => loadCat(activeTab), 0);
    return () => clearTimeout(t);
  }, [activeTab, loadCat]);

  const switchTab = (id: string) => {
    if (id === activeTab && !more && !searchResult) return;
    setActiveTab(id);
    setMore(null);
    setSearchResult(null);
  };

  const openMore = (title: string, type: number, sid = '') => {
    const m = { title, type: String(type), sid };
    setMore(m);
    moreRef.current = { next: 1, busy: false };
    setMorePage(EMPTY_PAGE);
    setTimeout(() => loadMoreList(m), 0);
  };

  const doSearch = async () => {
    const q = kw.trim();
    if (!q) return;
    setSearching(true);
    setSearchResult([]);
    try {
      const d = await getJSON<{ list: HgCard[] }>(`/api/huangguo/search?kw=${encodeURIComponent(q)}`);
      setSearchResult(d.list);
    } catch {
      setSearchResult([]);
    } finally {
      setSearching(false);
    }
  };

  const inSubView = !!more || !!searchResult;

  const content = searchResult ? (
    <div>
      <BackRow title={`「${kw}」的搜索结果`} onBack={() => setSearchResult(null)} />
      {searching && (
        <div className="py-10 flex justify-center">
          <Spinner />
        </div>
      )}
      {!searching && searchResult.length === 0 && (
        <div className="py-10 text-center text-sm text-muted">没有找到相关短剧</div>
      )}
      {!searching && <CardGrid list={searchResult} onPlay={setPlaying} />}
    </div>
  ) : more ? (
    <div>
      <BackRow title={`${more.title} · 全部`} onBack={() => setMore(null)} />
      <CardGrid list={morePage.list} onPlay={setPlaying} />
      <Sentinel active={morePage.next != null && !morePage.busy} onHit={() => loadMoreList(more)} />
      <div className="py-6 text-center text-xs text-muted">
        {morePage.busy ? '加载中…' : morePage.next == null ? (morePage.list.length ? '没有更多了' : '暂无内容') : '上拉加载更多'}
      </div>
    </div>
  ) : activeTab === '__chosen__' ? (
    chooseError ? (
      <div className="py-10 text-center text-sm text-muted">{chooseError}，请稍后重试</div>
    ) : !choose ? (
      <div className="py-10 flex justify-center">
        <Spinner />
      </div>
    ) : (
      <div>
        {[...choose.modules, ...choose.specials].map((mod) =>
          mod.list.length ? (
            <section key={mod.title + mod.moreType} className="pt-4">
              <div className="flex items-center justify-between px-4 pb-2">
                <h2 className="text-[15px] font-bold">{mod.title}</h2>
                <button
                  className="text-xs text-muted flex items-center gap-0.5"
                  onClick={() => openMore(mod.title, mod.moreType, mod.sectionId || '')}
                >
                  {mod.moreType === 1 ? '更多' : '全部'} <span aria-hidden>›</span>
                </button>
              </div>
              {mod.desc && <p className="px-4 pb-2 text-xs text-muted line-clamp-2">{mod.desc}</p>}
              <div className="flex gap-2.5 overflow-x-auto px-4 pb-1 no-scrollbar">
                {mod.list.map((c) => (
                  <div key={c.id} className="shrink-0 w-[120px]">
                    <HgCardView card={c} onPlay={setPlaying} />
                  </div>
                ))}
              </div>
            </section>
          ) : null
        )}
        {choose.suggest && choose.suggest.list.length > 0 && (
          <section className="pt-4">
            <h2 className="px-4 pb-2 text-[15px] font-bold">{choose.suggest.title || '猜你喜欢'}</h2>
            {choose.suggest.desc && <p className="px-4 pb-2 text-xs text-muted line-clamp-2">{choose.suggest.desc}</p>}
            <CardGrid list={choose.suggest.list} onPlay={setPlaying} dense />
          </section>
        )}
        <div className="h-8" />
      </div>
    )
  ) : (
    <div>
      {cat.error && cat.list.length === 0 && (
        <div className="py-10 text-center text-sm text-muted">加载失败，请稍后重试</div>
      )}
      {!cat.error && cat.list.length === 0 && !cat.busy && (
        <div className="py-10 text-center text-sm text-muted">此分类暂无内容</div>
      )}
      <CardGrid list={cat.list} onPlay={setPlaying} />
      <Sentinel active={cat.next != null && !cat.busy && !cat.error} onHit={() => loadCat(activeTab)} />
      <div className="py-6 text-center text-xs text-muted">
        {cat.busy ? '加载中…' : cat.next == null ? (cat.list.length ? '没有更多了' : '') : '上拉加载更多'}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface text-content">
      <Header />
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
            placeholder="搜索黄果短剧…"
            value={kw}
            maxLength={80}
            onChange={(e) => setKw(e.target.value)}
          />
          <button type="submit" className="btn h-9 px-4 text-sm" disabled={searching}>
            搜索
          </button>
        </form>
      </div>
      <div className="sticky top-14 z-30 bg-surface/90 backdrop-blur border-b border-line mt-3">
        <div className="max-w-6xl mx-auto flex gap-1 overflow-x-auto px-4 py-1.5 no-scrollbar">
          <SubTab label="精选" active={activeTab === '__chosen__' && !inSubView} onClick={() => switchTab('__chosen__')} />
          {tabs.map((t) => (
            <SubTab key={t.id} label={t.name} active={activeTab === t.id && !inSubView} onClick={() => switchTab(t.id)} />
          ))}
        </div>
      </div>
      <main className="max-w-6xl mx-auto">{content}</main>
      {playing && <HuangguoPlayer id={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
