import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { LiveRoomError, resolveLiveRoom } from '@/lib/live-room-resolve';
import type { LiveRoomInfo } from '@/lib/types';

/**
 * 播放列表接口：直播间地址走解析器生成单频道列表（JSON 与 M3U 导出），
 * 解析错误按状态码透出；普通 M3U 路径不受影响。上游 M3U 用 mock fetch，解析器 mock 掉。
 */

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: true })),
  isValidProxyUrl: vi.fn(() => true),
  isBlockedByDNS: vi.fn(async () => false),
}));

vi.mock('@/lib/live-room-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/live-room-resolve')>();
  return { ...actual, resolveLiveRoom: vi.fn() };
});

const resolveMock = vi.mocked(resolveLiveRoom);

const INFO: LiveRoomInfo = {
  platform: 'huya',
  roomUrl: 'https://www.huya.com/100',
  roomId: '100',
  owner: 'Uzi',
  title: '来了来了来了',
  avatar: 'https://huyaimg.msstatic.com/a.jpg',
  living: false,
  streams: [],
};

const M3U = ['#EXTM3U', '#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1', 'https://cdn.test/cctv1.m3u8', ''].join('\n');

function makeRequest(query: Record<string, string>): Request {
  const sp = new URLSearchParams(query);
  return new Request(`https://local.test/api/live/playlist?${sp.toString()}`, {
    headers: { cookie: `${SESSION_COOKIE}=${signSession().token}` },
  });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://iptv.test/list.m3u') {
        return new Response(M3U, { status: 200, headers: { 'content-type': 'audio/x-mpegurl' } });
      }
      return new Response('not found', { status: 404 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resolveMock.mockReset();
});

describe('GET /api/live/playlist 直播间地址', () => {
  it('解析成单频道播放列表：主播为台名、平台为分组、规范地址为频道地址；force 透传', async () => {
    resolveMock.mockResolvedValue(INFO);
    const res = await GET(makeRequest({ url: 'https://www.huya.com/uzi', force: '1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: '虎牙 · Uzi',
      channels: [
        { id: 'huya:100', name: 'Uzi', url: 'https://www.huya.com/100', logo: 'https://huyaimg.msstatic.com/a.jpg', group: '虎牙' },
      ],
      groups: ['虎牙'],
    });
    expect(resolveMock).toHaveBeenCalledWith('https://www.huya.com/uzi', { force: true });
  });

  it('format=m3u 导出同样可用', async () => {
    resolveMock.mockResolvedValue(INFO);
    const res = await GET(makeRequest({ url: 'https://www.huya.com/100', format: 'm3u' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('mpegurl');
    const text = await res.text();
    expect(text).toContain('#PLAYLIST:虎牙 · Uzi');
    expect(text).toContain('tvg-id="huya:100"');
    expect(text).toContain('group-title="虎牙",Uzi');
    expect(text).toContain('\nhttps://www.huya.com/100');
  });

  it('解析器错误按其状态码透出', async () => {
    resolveMock.mockRejectedValueOnce(new LiveRoomError('斗鱼直播间不存在', 404));
    const res = await GET(makeRequest({ url: 'https://www.douyu.com/1' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '斗鱼直播间不存在' });
  });

  it('普通 M3U 订阅不经过解析器', async () => {
    const res = await GET(makeRequest({ url: 'https://iptv.test/list.m3u' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: { name: string }[]; groups: string[] };
    expect(body.channels.map((c) => c.name)).toEqual(['CCTV-1']);
    expect(body.groups).toEqual(['央视']);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
