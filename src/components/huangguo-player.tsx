'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * 黄果竖屏短剧播放器（移植自 huangguo web 前端的 App 同款交互）：
 * 预告先行 → 正片 1..N，自动连播，横滑切集，选集底弹，进度拖动。
 * 流地址 /api/huangguo/m3u8/<id>/<ep> 已本源化（key/分片走 FreeTV 代理）。
 */

interface HgDetailClient {
  title: string;
  summary: string;
  cover: string;
  totalEp: number;
  updateEp: number;
  previewEnable: boolean;
  chapters: Array<{ ep: number; title: string; mediaTime: number }>;
}

export function HuangguoPlayer({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<HgDetailClient | null>(null);
  const [error, setError] = useState('');
  const [ep, setEp] = useState(0); // 0 = 预告
  const [muted, setMuted] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [needGesture, setNeedGesture] = useState(false);
  const [progress, setProgress] = useState({ cur: 0, dur: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError('');
    fetch(`/api/huangguo/detail?id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json() as Promise<HgDetailClient>;
      })
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setEp(d.previewEnable ? 0 : 1);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '详情加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const playEpisode = useCallback(
    (next: number) => {
      setSheetOpen(false);
      setError('');
      setNeedGesture(false);
      setEp(next);
    },
    []
  );

  // 装载流：ep 变化时重建
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !detail || (ep === 0 && !detail.previewEnable)) return;
    const src = `/api/huangguo/m3u8/${encodeURIComponent(id)}/${ep === 0 ? 'preview' : ep}`;
    let destroyed = false;
    let hls: Hls | null = null;

    import('hls.js').then(({ default: HlsCtor }) => {
      if (destroyed) return;
      hlsRef.current?.destroy();
      if (HlsCtor.isSupported()) {
        hls = new HlsCtor({ maxBufferLength: 30 });
        hls.loadSource(src);
        hls.attachMedia(v);
        hls.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          handleSourceError();
        });
        hlsRef.current = hls;
      } else {
        v.src = src; // Safari 原生 HLS
      }
      v.play().catch(() => setNeedGesture(true));
    });

    const handleSourceError = () => {
      // 预告源失败 → 直接播第一集（个别剧预告缺失兜底）
      if (ep === 0 && detail.chapters.length > 0) {
        playEpisode(1);
      } else {
        setError('播放失败，请重试');
      }
    };
    const onErr = () => handleSourceError();
    v.addEventListener('error', onErr);

    return () => {
      destroyed = true;
      v.removeEventListener('error', onErr);
      hls?.destroy();
      hlsRef.current = null;
      v.removeAttribute('src');
      v.load();
    };
  }, [detail, ep, id, playEpisode]);

  const total = detail?.chapters.length ?? 0;
  const epLabel = ep === 0 ? `预告 / 共 ${total} 集` : `第 ${ep} 集 / 共 ${total} 集`;

  const onEnded = () => {
    if (ep === 0) {
      if (total > 0) playEpisode(1);
      return;
    }
    if (ep < total) playEpisode(ep + 1);
  };

  // 手势：单击播放/暂停；横滑切集
  const gesture = useRef({ x: 0, y: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    gesture.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const dx = e.clientX - gesture.current.x;
    const dy = e.clientY - gesture.current.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && (ep < total || ep === 0)) playEpisode(ep === 0 ? 1 : ep + 1);
      else if (dx > 0 && ep > 1) playEpisode(ep - 1);
      else if (dx > 0 && ep === 1 && detail?.previewEnable) playEpisode(0);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => setNeedGesture(true));
      else v.pause();
    }
  };

  const seekTo = (clientX: number, el: HTMLElement) => {
    const v = videoRef.current;
    if (!v || !v.duration || Number.isNaN(v.duration)) return;
    const r = el.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * v.duration;
  };

  const fmt = (t: number) => {
    const s = Math.max(0, Math.round(t || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col overflow-hidden">
      {/* 视频区 */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          preload="auto"
          muted={muted}
          className="block w-full h-full object-contain bg-black"
          onEnded={onEnded}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setProgress({ cur: v.currentTime, dur: v.duration || 0 });
          }}
          onPlaying={() => {
            setPlaying(true);
            setNeedGesture(false);
          }}
          onPause={() => setPlaying(false)}
        />
        {/* 手势层 */}
        <div
          className="absolute inset-0 z-[5] touch-pan-y"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />
        {!detail && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm">
            加载中…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <span className="text-red-400 text-sm">{error}</span>
            <button
              className="px-4 py-2 rounded-full bg-white/10 text-white text-sm"
              onClick={() => playEpisode(ep || 1)}
            >
              重试
            </button>
          </div>
        )}
        {needGesture && !error && (
          <button
            aria-label="播放"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[7] w-16 h-16 rounded-full bg-black/55 text-white text-2xl flex items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              videoRef.current?.play().catch(() => {});
            }}
          >
            ▶
          </button>
        )}
        {/* 顶部菜单 */}
        <div className="absolute top-3 left-0 right-0 flex items-center gap-2.5 px-3 z-[8]">
          <button
            aria-label="关闭"
            className="w-[34px] h-[34px] rounded-full bg-black/45 text-white flex items-center justify-center"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
          <span className="flex-1 text-center text-white/85 text-sm drop-shadow">{epLabel}</span>
          <button
            aria-label={muted ? '取消静音' : '静音'}
            className="w-[34px] h-[34px] rounded-full bg-black/45 text-white text-sm flex items-center justify-center"
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? '🔇' : '🔈'}
          </button>
        </div>
        {!playing && !needGesture && detail && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[6] w-16 h-16 rounded-full bg-black/50 text-white text-2xl flex items-center justify-center">
            ▶
          </div>
        )}
      </div>

      {/* 进度条 */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-950">
        <span className="text-[11px] text-neutral-400 tabular-nums w-9 text-center">
          {fmt(progress.cur)}
        </span>
        <div
          className="flex-1 h-5 flex items-center relative cursor-pointer touch-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX, e.currentTarget);
          }}
        >
          <div className="absolute left-0 right-0 h-[3px] rounded bg-neutral-700" />
          <div
            className="absolute left-0 h-[3px] rounded bg-pink-500"
            style={{ width: progress.dur ? `${(progress.cur / progress.dur) * 100}%` : '0' }}
          />
          <div
            className="absolute w-3 h-3 rounded-full bg-pink-500 -translate-x-1/2 shadow"
            style={{ left: progress.dur ? `${(progress.cur / progress.dur) * 100}%` : '0' }}
          />
        </div>
        <span className="text-[11px] text-neutral-400 tabular-nums w-9 text-center">
          {fmt(progress.dur)}
        </span>
      </div>

      {/* 底部选集条 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-neutral-800 bg-neutral-950">
        <span className="text-xs text-neutral-400 whitespace-nowrap">
          {ep === 0 ? '预告' : `选集 ${ep}`}
        </span>
        <span className="text-xs text-neutral-500 whitespace-nowrap">
          {detail && ep > 0 && detail.chapters[ep - 1]
            ? `总时长 ${fmt(detail.chapters[ep - 1].mediaTime)}`
            : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="px-3.5 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-xs"
            disabled={ep === 0 || (ep === 1 && !detail?.previewEnable)}
            onClick={() => {
              if (ep === 1) playEpisode(0);
              else if (ep > 1) playEpisode(ep - 1);
            }}
          >
            上一集
          </button>
          <button
            className="px-3.5 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-xs"
            disabled={ep >= total}
            onClick={() => playEpisode(ep === 0 ? 1 : ep + 1)}
          >
            下一集
          </button>
          <button
            className="px-3.5 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-xs"
            onClick={() => setSheetOpen((s) => !s)}
          >
            全集
          </button>
        </div>
      </div>

      {/* 选集底弹 */}
      {sheetOpen && detail && (
        <div className="absolute left-0 right-0 bottom-0 z-20 bg-neutral-900 rounded-t-2xl px-4 pt-3.5 pb-6 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <b className="text-[15px]">选集 · {detail.title}</b>
            <button aria-label="关闭选集" className="text-neutral-400" onClick={() => setSheetOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          {detail.summary && (
            <p className="text-xs text-neutral-300 leading-relaxed line-clamp-2 mb-3">{detail.summary}</p>
          )}
          <div className="grid grid-cols-5 gap-2 max-h-[40vh] overflow-y-auto">
            {detail.previewEnable && (
              <button
                className={cn(
                  'bg-neutral-800 border rounded-lg py-2.5 text-sm',
                  ep === 0 ? 'border-pink-500 text-pink-500' : 'border-neutral-700'
                )}
                onClick={() => playEpisode(0)}
              >
                预告
              </button>
            )}
            {detail.chapters.map((_, i) => (
              <button
                key={i}
                className={cn(
                  'bg-neutral-800 border rounded-lg py-2.5 text-sm',
                  ep === i + 1 ? 'border-pink-500 text-pink-500' : 'border-neutral-700'
                )}
                onClick={() => playEpisode(i + 1)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
