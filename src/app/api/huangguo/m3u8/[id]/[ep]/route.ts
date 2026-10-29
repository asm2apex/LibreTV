import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { andGetRaw, getDetail, HUANGGUO_API_BASE } from '@/lib/huangguo/client';
import { localizePlaylist, type SegMode } from '@/lib/huangguo/playlist';
import { safeToken } from '@/lib/huangguo/projection';

export const runtime = 'nodejs';

/** direct=浏览器直连 CDN（默认，服务器零视频流量）；proxy=分片/key 全代理（回退） */
const SEG_MODE: SegMode = process.env.HUANGGUO_SEG_MODE === 'proxy' ? 'proxy' : 'direct';

/**
 * 剧集正片 playlist 透传 + 本源化重写：
 * - KEY URI（静态 HLS key，上游相对路径 /api/app/vid/sec）→ /api/huangguo/vid-sec
 * - 分片绝对 URL → /api/huangguo/seg?u=…（浏览器 hls.js 跨域拉片不被 CDN CORS 卡死）
 * ep 取值：preview | 本地序号 1..N（先按服务器集号精确匹配，miss 按序号兜底，
 * 与 Go 版一致：单集剧服务器集号可能是系列号如 EP3）。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; ep: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id, ep } = await ctx.params;
  if (!safeToken(id) || !/^(preview|\d{1,4})$/.test(ep)) {
    return NextResponse.json({ error: '路径参数无效' }, { status: 400 });
  }

  let token = '';
  try {
    const d = await getDetail(id);
    if (ep === 'preview') {
      token = d.preview;
    } else {
      for (const ch of d.chapters) {
        if (String(ch.ep) === ep) {
          token = ch.token;
          break;
        }
      }
      if (!token) {
        const n = Number(ep);
        if (n >= 1 && n <= d.chapters.length) token = d.chapters[n - 1].token;
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '详情获取失败' },
      { status: 502 }
    );
  }
  if (!token) return NextResponse.json({ error: '没有这一集' }, { status: 404 });

  try {
    let raw = await andGetRaw(`/api/app/vid/h5/m3u8/${token}`);
    if (!raw.subarray(0, 7).equals(Buffer.from('#EXTM3U'))) {
      // token 失效重登一次再取
      raw = await andGetRaw(`/api/app/vid/h5/m3u8/${token}`, true);
      if (!raw.subarray(0, 7).equals(Buffer.from('#EXTM3U'))) {
        return NextResponse.json({ error: '上游未返回播放列表' }, { status: 502 });
      }
    }
    const playlist = localizePlaylist(raw.toString('utf8'), SEG_MODE, HUANGGUO_API_BASE);
    return new Response(playlist, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '上游请求失败' },
      { status: 502 }
    );
  }
}
