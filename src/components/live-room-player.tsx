'use client';

import { useCallback, useRef, useState } from 'react';
import { LIVE_ROOM_PLATFORM_LABEL } from '@/lib/live-room';
import type { LiveRoomInfo } from '@/lib/types';
import { LivePlayer } from './live-player';
import { Spinner } from './states';
import { useForceResolveLiveRoom, useLiveRoom } from './use-live-room';

/**
 * 平台直播间播放器：先解析（/api/live/room）再把流地址交给 LivePlayer。
 * - 候选流按解析给出的顺序依次尝试（FLV → HLS，第二条线路兜底）；
 * - 全部候选都失败、或播放中流地址过期 / 被切断：强制重新解析再播（20s 冷却防死循环）；
 * - 未开播不是错误：显示主播与标题的占位，可手动刷新状态；
 * - 「重新加载」也走强制重解析，旧地址多半已经过期。
 */

const RE_RESOLVE_COOLDOWN_MS = 20_000;

interface LiveRoomPlayerProps {
  roomUrl: string;
  title: string;
  onPrevChannel?: () => void;
  onNextChannel?: () => void;
}

const overlayButton = 'btn-ghost text-xs !bg-white/10 !text-white !border-white/20';

export function LiveRoomPlayer({ roomUrl, title, onPrevChannel, onNextChannel }: LiveRoomPlayerProps) {
  const query = useLiveRoom(roomUrl);
  const forceResolve = useForceResolveLiveRoom(roomUrl);
  const info = query.data;
  // 候选流下标绑定到产生它的解析结果：拿到新结果自动回到首选流，不需要 effect 兜一拍
  const [indexFor, setIndexFor] = useState<{ info: LiveRoomInfo | undefined; index: number }>({ info: undefined, index: 0 });
  const streamIndex = indexFor.info === info ? indexFor.index : 0;
  const [resolving, setResolving] = useState(false);
  const lastResolveRef = useRef(0);

  const reResolve = useCallback(async () => {
    lastResolveRef.current = Date.now();
    setResolving(true);
    try {
      await forceResolve();
    } catch {
      // 失败状态由 query.error 体现
    } finally {
      setResolving(false);
    }
  }, [forceResolve]);

  const streams = info?.streams ?? [];
  const current = streams[streamIndex];

  const handleFatal = useCallback(() => {
    // 先换下一路候选（另一种封装 / 另一条线路），都试过再强制重解析（流地址可能已过期）；
    // 冷却期内不再自动重解析，停在 LivePlayer 的错误层等用户手动重新加载
    if (streamIndex + 1 < streams.length) {
      setIndexFor({ info, index: streamIndex + 1 });
      return;
    }
    if (Date.now() - lastResolveRef.current > RE_RESOLVE_COOLDOWN_MS) void reResolve();
  }, [info, streamIndex, streams.length, reResolve]);

  if (!info) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
        {query.isError ? (
          <>
            <p className="text-danger text-sm">
              {query.error instanceof Error ? query.error.message : '直播间解析失败'}
            </p>
            <button className={overlayButton} onClick={() => void reResolve()} disabled={resolving}>
              重试
            </button>
          </>
        ) : (
          <>
            <Spinner size="lg" tone="onDark" />
            <p className="text-white/60 text-sm">正在解析直播间...</p>
          </>
        )}
      </div>
    );
  }

  if (!info.living) {
    const label = LIVE_ROOM_PLATFORM_LABEL[info.platform];
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-black px-6 text-center">
        <p className="text-white text-base font-medium">{info.owner || `${label} ${info.roomId}`} 未开播</p>
        {info.title && <p className="text-white/60 text-sm max-w-full truncate">{info.title}</p>}
        <button className={`${overlayButton} mt-2`} onClick={() => void reResolve()} disabled={resolving}>
          {resolving ? '刷新中...' : '刷新状态'}
        </button>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
        <p className="text-danger text-sm">开播中，但没有取到可播放的流地址</p>
        <button className={overlayButton} onClick={() => void reResolve()} disabled={resolving}>
          重新解析
        </button>
      </div>
    );
  }

  return (
    <LivePlayer
      url={current.url}
      title={title}
      onPrevChannel={onPrevChannel}
      onNextChannel={onNextChannel}
      onFatalError={handleFatal}
      onReload={() => void reResolve()}
    />
  );
}
