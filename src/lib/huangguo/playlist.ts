/** playlist 本源化改写：key 与分片 URI 都指向 FreeTV 自身路由 */

/**
 * 把 playlist 内的上游 URI 改写为本服务路由：
 * - HLS 静态 key（上游相对路径 …/vid/sec…）→ /api/huangguo/vid-sec
 * - 分片绝对 URL → /api/huangguo/seg?u=…（浏览器 hls.js 跨域拉片不被 CDN CORS 卡死）
 */
export function localizePlaylist(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return t.replace(/URI="([^"]*vid\/sec[^"]*)"/, 'URI="/api/huangguo/vid-sec"');
      }
      if (/^https?:\/\//i.test(t)) {
        return `/api/huangguo/seg?u=${encodeURIComponent(t)}`;
      }
      return line;
    })
    .join('\n');
}
