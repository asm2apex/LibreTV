import { describe, expect, it } from 'vitest';
import { localizePlaylist } from './playlist';
import { andGet, andGetRaw, getDetail } from './client';

/**
 * 黄果协议 live 冒烟：对真实上游全链路验证（游客自注册→推荐→分类→详情→playlist）。
 * 默认跳过，HUANGGUO_LIVE=1 时运行（对齐 live-room-resolve.live.test.ts 范式）。
 * 上游登录按 IP 限频（4007），CI/频繁跑会触发退避——按需手动执行。
 */
const live = process.env.HUANGGUO_LIVE === '1';
const d = live ? describe : describe.skip;

d('huangguo live 链路', () => {
  it('游客登录 → 首页推荐流返回卡片', { timeout: 30000 }, async () => {
    const m = await andGet('/api/app/playlet-recommend/home/suggestion?pageSize=12&sortType=0');
    const list = m['list'];
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).length).toBeGreaterThan(0);
  });

  it('分类 Tab 列表非空', { timeout: 30000 }, async () => {
    const m = await andGet('/api/app/playlet-tab/all');
    expect(Array.isArray(m['list'])).toBe(true);
    expect((m['list'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('精选分栏含至少一个模块', { timeout: 30000 }, async () => {
    const m = await andGet('/api/app/playlet-recommend/v2/home/choose?layoutVersion=2');
    expect(m['newModule'] || m['weekModule'] || m['hotModule']).toBeTruthy();
  });

  it('详情含分集与播放 token；playlist 可取且重写生效', { timeout: 45000 }, async () => {
    const m = await andGet('/api/app/playlet-recommend/home/suggestion?pageSize=12&sortType=0');
    const first = (m['list'] as Array<Record<string, unknown>>)[0];
    const id = String(first['id']);
    const detail = await getDetail(id);
    expect(detail.chapters.length).toBeGreaterThan(0);
    expect(detail.chapters[0].token).toBeTruthy();

    const raw = await andGetRaw(`/api/app/vid/h5/m3u8/${detail.chapters[0].token}`);
    expect(raw.subarray(0, 7).toString('utf8')).toBe('#EXTM3U');
    const text = raw.toString('utf8');
    const API = 'https://d2jgz4wrcczusu.cloudfront.net';

    // direct（默认）：key 绝对化到上游、分片原样直连
    const direct = localizePlaylist(text, 'direct', API);
    if (text.includes('URI=')) {
      expect(direct).toContain(`URI="${API}/api/app/vid/sec"`);
    }
    for (const line of direct.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) expect(t.startsWith('/api/')).toBe(false);
    }

    // proxy（回退）：key 本源化、分片全部走 seg 代理
    const proxied = localizePlaylist(text, 'proxy', API);
    expect(proxied).not.toContain('URI="/api/app/vid/sec"');
    if (text.includes('URI=')) {
      expect(proxied).toContain('URI="/api/huangguo/vid-sec"');
    }
    for (const line of proxied.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) {
        expect(t.startsWith('/api/huangguo/seg?u=')).toBe(true);
      }
    }
  });
});
