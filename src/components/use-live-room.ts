'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';

/**
 * 平台直播间解析查询（/api/live/room）。页面信息条与直播间播放器共用同一 key，react-query 自动去重。
 * 独立成小模块：页面要静态引用它，而播放器（含 artplayer）仍按需加载。
 */
export const liveRoomQueryKey = (roomUrl: string) => ['liveRoom', roomUrl] as const;

export function useLiveRoom(roomUrl: string | undefined) {
  return useQuery({
    queryKey: liveRoomQueryKey(roomUrl ?? ''),
    queryFn: ({ signal }) => api.liveRoom(roomUrl ?? '', false, signal),
    enabled: Boolean(roomUrl),
    // 开播状态与流地址都不需要秒级新鲜；流地址失效由播放器显式强制重解析
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** 强制重新解析（跳过服务端缓存），结果写回同一 query，信息条与播放器同步更新 */
export function useForceResolveLiveRoom(roomUrl: string) {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: liveRoomQueryKey(roomUrl),
        queryFn: ({ signal }) => api.liveRoom(roomUrl, true, signal),
        staleTime: 0,
      }),
    [queryClient, roomUrl]
  );
}
