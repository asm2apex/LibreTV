import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { LiveRoomError, resolveLiveRoom } from '@/lib/live-room-resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 平台直播间解析：GET /api/live/room?url=<斗鱼 / 虎牙直播间地址>&force=1
 * 返回主播、标题、开播状态与候选流地址（LiveRoomInfo）。
 * 只算地址不转流：媒体由浏览器直连平台 CDN。force=1 跳过 60s 缓存，供播放器在流地址失效时重取。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = sp.get('url')?.trim();
  if (!url) return jsonError('缺少 url 参数', 400);

  try {
    const info = await resolveLiveRoom(url, { force: sp.get('force') === '1' });
    return NextResponse.json(info, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof LiveRoomError) return jsonError(err.message, err.status);
    return jsonError(`直播间解析失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
