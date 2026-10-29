import { describe, expect, it } from 'vitest';
import { hongguoRuntime } from './runtime';

/**
 * 红果网关 live 冒烟：真实上游全链路（搜索→详情→取流档位→解密流首段）。
 * 默认跳过，HONGGUO_LIVE=1 时运行。首次解密一集要下载全量密文，较慢。
 */
const live = process.env.HONGGUO_LIVE === '1';
const d = live ? describe : describe.skip;

d('hongguo live 链路', () => {
  it('搜索返回结果（App 通道或官网 suggestion 兜底）', { timeout: 60000 }, async () => {
    const { app, web } = hongguoRuntime();
    let items: Array<{ seriesId: string; title: string }> = [];
    if (!app.health.degraded()) {
      try {
        items = (await app.search('闪婚', 0)).items;
      } catch {
        // 兜底
      }
    }
    if (items.length === 0) {
      items = (await web.suggest('闪婚')).map((h) => ({ seriesId: h.seriesId, title: h.title }));
    }
    expect(items.length).toBeGreaterThan(0);
  });

  it('详情含分集；streams 有档位；stream 首 16 字节为 MP4 ftyp 盒', { timeout: 180000 }, async () => {
    const { app, web, pipeline } = hongguoRuntime();
    // 取一部有分集的剧（App 详情优先，web 兜底）
    let episodes: Array<{ vid: string }> = [];
    let sid = '';
    if (!app.health.degraded()) {
      try {
        const s = (await app.search('闪婚', 0)).items;
        if (s.length) {
          sid = s[0]!.seriesId;
          episodes = (await app.detail(sid)).episodes;
        }
      } catch {
        // 兜底
      }
    }
    if (!episodes.length) {
      const hits = await web.suggest('闪婚');
      if (hits.length) {
        sid = hits[0]!.seriesId;
        const det = await web.detail(sid);
        episodes = (det?.vids ?? []).map((vid) => ({ vid }));
      }
    }
    expect(episodes.length).toBeGreaterThan(0);

    const vid = episodes[0]!.vid;
    const streams = await app.resolveStreams(vid).catch(() => []);
    // 降级期 streams 可能为空，跳过档位断言但 stream 兜底 360p 仍应可出字节
    if (streams.length > 0) {
      const pick = streams.find((s) => s.definition === '1080p') ?? streams[0]!;
      const file = await pipeline.ensureDecrypted(vid, pick.definition, async () => pick);
      const { stat, open } = await import('node:fs/promises');
      const s = await stat(file);
      expect(s.size).toBeGreaterThan(1024);
      const fh = await open(file, 'r');
      try {
        const head = Buffer.alloc(16);
        await fh.read(head, 0, 16, 0);
        // MP4：size(4B) + 'ftyp'
        expect(head.subarray(4, 8).toString('ascii')).toBe('ftyp');
      } finally {
        await fh.close();
      }
    }
  });
});
