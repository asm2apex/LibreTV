import type { LiveChannel, LiveRoomInfo, LiveRoomPlatform } from './types';

/**
 * 平台直播间（斗鱼 / 虎牙）地址识别与规范化。纯函数，客户端与服务端共用。
 *
 * 直播源除 M3U 订阅外也接受平台直播间页面地址：服务端按平台算出带签名的流地址，
 * 浏览器直连平台 CDN 播放（CDN 允许跨域且不校验 Referer，媒体流量不经本站）。
 * 这里只回答「是不是直播间地址、属于哪个平台、房间标识是什么」，取流在 live-room-resolve.ts。
 * 房间标识既可能是数字房间号，也可能是主播别名（huya.com/uzi、douyu.com/yyf）；
 * 别名换算成数字房间号要访问平台，由解析侧完成，并以数字形式作为频道唯一标识。
 */

export const LIVE_ROOM_PLATFORM_LABEL: Record<LiveRoomPlatform, string> = {
  huya: '虎牙',
  douyu: '斗鱼',
};

/** 精确主机名白名单：子域名不做后缀匹配，api./hd. 等功能域名不是直播间 */
const PLATFORM_HOSTS: Record<string, LiveRoomPlatform> = {
  'huya.com': 'huya',
  'www.huya.com': 'huya',
  'm.huya.com': 'huya',
  'douyu.com': 'douyu',
  'www.douyu.com': 'douyu',
  'm.douyu.com': 'douyu',
};

/** 平台站内的功能路径（分类、搜索、接口等），单段路径但不是直播间 */
const RESERVED_PATHS: Record<LiveRoomPlatform, Set<string>> = {
  huya: new Set(['l', 'g', 'search', 'video', 'v', 'live', 'm', 'cache.php', 'udb_web', 'fans']),
  douyu: new Set([
    'directory', 'topic', 'g', 'search', 'member', 'betard', 'swf_api', 'lapi', 'japi', 'gapi',
    'wgapi', 'api', 'video', 'videos', 'room',
  ]),
};

/** 房间号 / 主播别名：平台只用字母数字与 -_ */
const ROOM_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface LiveRoomRef {
  platform: LiveRoomPlatform;
  /** 地址中的房间标识：数字房间号或主播别名，原样保留（大小写由平台自行归一） */
  roomKey: string;
}

export function parseLiveRoomUrl(url: string): LiveRoomRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const platform = PLATFORM_HOSTS[parsed.hostname.toLowerCase()];
  if (!platform) return null;

  // 斗鱼专题页 /topic/xxx?rid=123：房间号在查询串里
  if (platform === 'douyu') {
    const rid = parsed.searchParams.get('rid');
    if (rid && /^\d+$/.test(rid)) return { platform, roomKey: rid };
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const key = segments[0];
  if (!ROOM_KEY_RE.test(key) || RESERVED_PATHS[platform].has(key.toLowerCase())) return null;
  return { platform, roomKey: key };
}

export function canonicalLiveRoomUrl(platform: LiveRoomPlatform, roomKey: string): string {
  return `https://www.${platform}.com/${roomKey}`;
}

export function isLiveRoomUrl(url: string): boolean {
  return parseLiveRoomUrl(url) !== null;
}

export function liveRoomPlatformOf(url: string): LiveRoomPlatform | null {
  return parseLiveRoomUrl(url)?.platform ?? null;
}

/** 解析结果 → 直播频道：一个直播间一个频道，按平台分组，以数字房间号地址为唯一标识 */
export function liveRoomChannel(info: LiveRoomInfo): LiveChannel {
  const label = LIVE_ROOM_PLATFORM_LABEL[info.platform];
  return {
    id: `${info.platform}:${info.roomId}`,
    name: info.owner || `${label} ${info.roomId}`,
    url: info.roomUrl,
    logo: info.avatar,
    group: label,
  };
}
