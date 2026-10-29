'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * 红果竖屏播放器（移植自 hongguo web 前端）：
 * MP4 渐进流（/api/hongguo/stream?vid=&q=），原生 controls，
 * 画质切换（浏览器可解编码过滤）、进度记忆（localStorage 3s 节流）、
 * 70% 预取下一集（Range 0-0 驱动服务端解密管线）、自动连播、选集底弹。
 */

export interface HgEpisode {
  vid: string;
  index: number;
  title: string | null;
  durationSec: number;
}

interface StreamOption {
  definition: string;
  codec: string;
  size?: number;
  width?: number;
  height?: number;
}

// 浏览器原生可解：H.264 与 HEVC（Chrome 107+ 硬解/Safari）；BVC2 等字节自研编码不可
function playableCodec(c: string): boolean {
  return /h264|avc|bytevc1|hvc1|hevc|hev1/i.test(String(c || ''));
}

function codecLabel(c: string): string {
  const s = String(c || '').toLowerCase();
  if (/h264|avc/.test(s)) return 'H.264';
  if (/bytevc1|hvc1|hevc|hev1/.test(s)) return 'HEVC';
  return s ? s.toUpperCase() : '未知';
}

function fmtTime(sec: number): string {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const progKey = (sid: string, vid: string) => `hongguo:prog:${sid}:${vid}`;

export function HongguoPlayer({
  seriesId,
  title,
  episodes,
  startIndex,
  onClose,
}: {
  seriesId: string;
  title: string;
  episodes: HgEpisode[];
  startIndex: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIndex);
  const [streams, setStreams] = useState<StreamOption[]>([]);
  const [qualityIdx, setQualityIdx] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const prefetchedRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }, []);

  const ep = episodes[idx];

  // 加载一集：streams 探测 → 选默认档 → 起播
  const loadEp = useCallback(
    async (vid: string, epIdx: number) => {
      setLoading(true);
      setStreams([]);
      setQualityIdx(-1);
      prefetchedRef.current = false;
      showToast('解析中…（首次含下载解密，稍候）');
      try {
        const r = await fetch(`/api/hongguo/streams?vid=${vid}`);
        const d = (await r.json()) as { streams?: StreamOption[]; error?: string };
        if (!r.ok || !d.streams) throw new Error(d.error || `HTTP ${r.status}`);
        setStreams(d.streams);
        // 默认档：1080p 可解则 1080p，否则最高可解档（streams 已按档位降序）
        let prefer = d.streams.findIndex((x) => x.definition === '1080p' && playableCodec(x.codec));
        if (prefer < 0) prefer = d.streams.findIndex((x) => playableCodec(x.codec));
        if (prefer < 0) prefer = 0;
        setQualityIdx(prefer);
        const v = videoRef.current;
        if (v && d.streams[prefer]) {
          v.src = `/api/hongguo/stream?vid=${vid}&q=${encodeURIComponent(d.streams[prefer].definition)}`;
          v.play().catch(() => {});
        }
        // 已看标记
        try {
          const seen = JSON.parse(localStorage.getItem(`hongguo:seen:${seriesId}`) || '{}');
          seen[vid] = Date.now();
          localStorage.setItem(`hongguo:seen:${seriesId}`, JSON.stringify(seen));
        } catch { /* 存储不可用不影响播放 */ }
        void epIdx;
      } catch (e) {
        showToast(`失败：${e instanceof Error ? e.message : '解析失败'}`);
      } finally {
        setLoading(false);
      }
    },
    [seriesId, showToast]
  );

  useEffect(() => {
    if (ep) loadEp(ep.vid, idx);
  }, [ep, idx, loadEp]);

  const jump = useCallback(
    (d: number) => {
      const next = idx + d;
      if (next < 0 || next >= episodes.length) {
        showToast(d > 0 ? '已经是最后一集' : '已经是第一集');
        return;
      }
      setIdx(next);
    },
    [idx, episodes.length, showToast]
  );

  const playQuality = (vid: string, st: StreamOption) => {
    const v = videoRef.current;
    if (!v) return;
    v.src = `/api/hongguo/stream?vid=${vid}&q=${encodeURIComponent(st.definition)}`;
    v.play().catch(() => {});
  };

  // 进度记忆 + 70% 预取下一集
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !v.duration || Number.isNaN(v.duration) || !ep) return;
    const now = Date.now();
    const last = (v as HTMLVideoElement & { _lastSave?: number })._lastSave ?? 0;
    if (now - last < 3000) return;
    (v as HTMLVideoElement & { _lastSave?: number })._lastSave = now;
    try {
      localStorage.setItem(progKey(seriesId, ep.vid), JSON.stringify({ t: v.currentTime, d: v.duration }));
    } catch { /* 忽略 */ }
    if (!prefetchedRef.current && v.currentTime > v.duration * 0.7) {
      const next = episodes[idx + 1];
      const cur = streams[qualityIdx];
      if (next && cur) {
        prefetchedRef.current = true;
        fetch(`/api/hongguo/stream?vid=${next.vid}&q=${encodeURIComponent(cur.definition)}`, {
          headers: { Range: 'bytes=0-0' },
        }).catch(() => {});
      }
    }
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v || !ep) return;
    try {
      const saved = JSON.parse(localStorage.getItem(progKey(seriesId, ep.vid)) || 'null') as
        | { t: number }
        | null;
      if (saved && saved.t > 5 && saved.t < v.duration - 5) {
        v.currentTime = saved.t;
        showToast(`已从 ${fmtTime(saved.t)} 续播`);
      }
    } catch { /* 忽略 */ }
  };

  // 键盘：←/→ 切集，Esc 关闭
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowLeft') jump(-1);
      if (ev.key === 'ArrowRight') jump(1);
      if (ev.key === 'Escape') {
        if (sheetOpen) setSheetOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jump, onClose, sheetOpen]);

  const seenMap = (() => {
    try {
      return JSON.parse(localStorage.getItem(`hongguo:seen:${seriesId}`) || '{}') as Record<string, number>;
    } catch {
      return {};
    }
  })();

  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-950 border-b border-neutral-800 z-10">
        <button className="w-9 h-9 -ml-1 text-white/80 hover:text-white text-xl leading-none" onClick={onClose} aria-label="返回">
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white/90 truncate">{title} · 第 {idx + 1} 集</div>
        </div>
        {streams.length > 0 && (
          <select
            className="bg-neutral-800 border border-neutral-700 rounded-full text-xs text-white px-3 py-1.5"
            value={qualityIdx}
            onChange={(e) => {
              const i = Number(e.target.value);
              setQualityIdx(i);
              if (ep && streams[i]) playQuality(ep.vid, streams[i]);
            }}
            aria-label="画质"
          >
            {streams.map((x, i) => (
              <option key={i} value={i} disabled={!playableCodec(x.codec)}>
                {x.definition} · {codecLabel(x.codec)}{playableCodec(x.codec) ? '' : ' · 浏览器不支持'}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 视频（原生 controls，MP4 渐进流） */}
      <div className="relative flex-1 min-h-0 bg-black">
        <video
          ref={videoRef}
          playsInline
          autoPlay
          controls
          preload="metadata"
          className="block w-full h-full object-contain bg-black"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={() => jump(1)}
        />
        {loading && (
          <div className="absolute left-0 right-0 bottom-16 text-center text-white/60 text-sm pointer-events-none">
            解析中…
          </div>
        )}
        {toast && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-24 bg-black/75 text-white/85 text-xs rounded-full px-4 py-2 pointer-events-none">
            {toast}
          </div>
        )}
      </div>

      {/* 底栏 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-neutral-800 bg-neutral-950">
        <button
          className="px-3.5 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-xs text-white"
          onClick={() => setSheetOpen(true)}
        >
          选集
        </button>
        <div className="flex-1 text-center text-xs text-neutral-400 truncate">
          {ep ? (ep.title ? `${idx + 1}. ${ep.title}` : `第 ${idx + 1} 集 / 共 ${episodes.length} 集`) : ''}
        </div>
        <button className="px-3.5 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-xs text-white" onClick={() => jump(-1)}>
          上一集
        </button>
        <button className="px-3.5 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-xs text-white" onClick={() => jump(1)}>
          下一集
        </button>
      </div>

      {/* 选集底弹 */}
      {sheetOpen && (
        <div className="absolute inset-0 z-20" onClick={() => setSheetOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute left-0 right-0 bottom-0 bg-neutral-900 rounded-t-2xl px-4 pt-3 pb-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <b className="text-[15px] text-white">选集 · 共 {episodes.length} 集</b>
              <button className="text-neutral-400" onClick={() => setSheetOpen(false)} aria-label="关闭选集">
                <Icon name="close" />
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2 max-h-[40vh] overflow-y-auto">
              {episodes.map((e, i) => (
                <button
                  key={e.vid}
                  ref={i === idx ? (el) => el?.scrollIntoView({ block: 'center' }) : undefined}
                  className={cn(
                    'rounded-lg py-2.5 text-sm border',
                    i === idx
                      ? 'bg-red-600 border-red-500 text-white'
                      : seenMap[e.vid]
                        ? 'bg-amber-900/40 border-amber-700/60 text-amber-300'
                        : 'bg-neutral-800 border-neutral-700 text-white'
                  )}
                  onClick={() => {
                    setSheetOpen(false);
                    if (i !== idx) setIdx(i);
                  }}
                >
                  {e.index}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
