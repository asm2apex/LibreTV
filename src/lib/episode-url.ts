/**
 * 分集地址分类：官源页面 vs 媒体直链。
 *
 * 部分采集站（官源解析型）给出的分集地址是爱奇艺 / 腾讯 / 优酷 / 芒果 / B 站等
 * 平台的网页，不是 m3u8。这类地址必须先经解析接口换成可播地址，否则 hls.js
 * 会把 HTML 当清单解析而硬失败。客户端据此决定是否走 /api/parse，
 * 服务端据此限定解析接口只替这些平台的页面付费解析（防止额度被滥用）。
 */

/** 官方视频平台域名（含子域）：命中即视为需要解析的页面地址 */
const PLATFORM_HOSTS = [
  'iqiyi.com',
  'qq.com',
  'youku.com',
  'mgtv.com',
  'bilibili.com',
  'b23.tv',
  'sohu.com',
  'pptv.com',
  'le.com',
  '1905.com',
  'migu.cn',
  'ixigua.com',
  'pps.tv',
];

/** 媒体直链后缀：带这些后缀的地址即便落在平台域名下也直接交给播放器 */
const MEDIA_EXT_RE = /\.(m3u8|m3u|mp4|m4v|flv|ts|webm|mkv|mov|mp3|aac)$/i;

function pathnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

/** 地址是否为官方平台的 http(s) 页面（域名精确后缀匹配，防 evil-qq.com 类误判） */
export function isPlatformPageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return PLATFORM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 地址路径是否以媒体后缀结尾（忽略查询串与锚点） */
export function hasMediaExtension(url: string): boolean {
  const path = pathnameOf(url);
  return path !== null && MEDIA_EXT_RE.test(path);
}

/** 分集地址是否需要经解析接口才能播放 */
export function needsParse(url: string): boolean {
  if (pathnameOf(url) === null) return false;
  return !hasMediaExtension(url) && isPlatformPageUrl(url);
}
