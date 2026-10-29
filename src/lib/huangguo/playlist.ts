/** playlist 改写：默认直连模式让视频流量绕过服务器，代理模式留作回退 */

export type SegMode = 'direct' | 'proxy';

/**
 * direct（默认，实测 CDN 与 key 端点均返回 Access-Control-Allow-Origin: *）：
 *   - 分片绝对 URL 原样保留 → 浏览器直连 CDN，服务器零视频流量
 *   - key 相对路径 …/vid/sec 绝对化到上游 API 域 → 浏览器直连取 16B key
 * proxy（回退，上游收紧 CORS/防盗链时切换）：key → /api/huangguo/vid-sec，
 *   分片 → /api/huangguo/seg?u=…，全部经服务器转发（双向消耗带宽）。
 */
export function localizePlaylist(text: string, mode: SegMode, apiBase: string): string {
  const absolutizeKey = (line: string) =>
    line.replace(/URI="([^"]*vid\/sec[^"]*)"/, `URI="${apiBase}/api/app/vid/sec"`);
  const proxyKey = (line: string) => line.replace(/URI="([^"]*vid\/sec[^"]*)"/, 'URI="/api/huangguo/vid-sec"');

  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return mode === 'direct' ? absolutizeKey(t) : proxyKey(t);
      }
      if (mode === 'proxy' && /^https?:\/\//i.test(t)) {
        return `/api/huangguo/seg?u=${encodeURIComponent(t)}`;
      }
      return line; // direct：分片绝对 URL 原样（浏览器直连）
    })
    .join('\n');
}
