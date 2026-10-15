import { describe, expect, it } from 'vitest';
import { resolveLiveRoom } from './live-room-resolve';

/**
 * 真网冒烟：各找一个正在开播的虎牙 / 斗鱼房间解析一次，并探首个流地址的响应头（直连可行性）。
 * 依赖外网与平台现状，默认跳过；平台疑似改版时手动跑：
 *   LIVE_E2E=1 npx vitest run src/lib/live-room-resolve.live.test.ts
 */
const enabled = process.env.LIVE_E2E === '1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** 以浏览器跨域请求的姿态取响应头：读到首块数据即断开，不下载媒体 */
async function headProbe(url: string): Promise<{ status: number; acao: string | null; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Origin: 'http://localhost:8080' }, signal: controller.signal });
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read();
      try { await reader.cancel(); } catch { /* 忽略 */ }
    }
    return { status: res.status, acao: res.headers.get('access-control-allow-origin'), contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!enabled)('平台直播间真网冒烟', () => {
  it('虎牙：列表接口取一个开播房间 → 解析 → FLV 可跨域直连', async () => {
    const list = (await (
      await fetch('https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId=1&tagAll=0&page=1', {
        headers: { 'User-Agent': UA },
      })
    ).json()) as { data: { datas: { profileRoom: number }[] } };
    const room = String(list.data.datas[0].profileRoom);
    const info = await resolveLiveRoom(`https://www.huya.com/${room}`, { force: true });
    expect(info.living).toBe(true);
    expect(info.owner).not.toBe('');
    expect(info.streams.length).toBeGreaterThanOrEqual(2);
    const probe = await headProbe(info.streams[0].url);
    expect(probe.status).toBe(200);
    expect(probe.acao).toBe('*');
    expect(probe.contentType).toContain('flv');
  }, 40_000);

  it('斗鱼：分区列表取一个开播房间 → 签名取流 → FLV 可跨域直连', async () => {
    const list = (await (
      await fetch('https://www.douyu.com/gapi/rkc/directory/mixList/0_0/1', {
        headers: { 'User-Agent': UA, Referer: 'https://www.douyu.com/' },
      })
    ).json()) as { data: { rl: { rid: number; type: number }[] } };
    const rid = String((list.data.rl.find((r) => r.type === 1) ?? list.data.rl[0]).rid);
    const info = await resolveLiveRoom(`https://www.douyu.com/${rid}`, { force: true });
    expect(info.living).toBe(true);
    expect(info.streams).toHaveLength(1);
    expect(info.streams[0].url).toMatch(/\.flv\?/);
    const probe = await headProbe(info.streams[0].url);
    expect(probe.status).toBe(200);
    expect(probe.acao).toBe('*');
    expect(probe.contentType).toContain('flv');
  }, 40_000);
});
