import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstream } from '@/lib/fetch-utils';
import { deobfuscateImage } from '@/lib/huangguo/protocol';

export const runtime = 'nodejs';

const IMG_CDN = 'https://zzzznnn.lkkwip.cn/imageView/1/';

/** 封面代理：CDN 返回前 100 字节 XOR 混淆，去混淆后按扩展名给 MIME */
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { path } = await ctx.params;
  const rel = (path || []).join('/');
  if (!rel || rel.includes('..') || rel.length > 512) {
    return NextResponse.json({ error: '图片路径无效' }, { status: 400 });
  }

  try {
    const res = await fetchUpstream(IMG_CDN + rel, { timeoutMs: 10000 });
    if (!res.ok) return NextResponse.json({ error: '上游图片获取失败' }, { status: 502 });
    const out = deobfuscateImage(Buffer.from(await res.arrayBuffer()));
    let mime = 'image/jpeg';
    if (rel.endsWith('.webp')) mime = 'image/webp';
    else if (rel.endsWith('.png')) mime = 'image/png';
    else if (rel.endsWith('.gif')) mime = 'image/gif';
    return new Response(new Uint8Array(out), {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return NextResponse.json({ error: '上游图片获取失败' }, { status: 502 });
  }
}
