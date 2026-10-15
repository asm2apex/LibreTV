import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { LiveRoomError, resolveLiveRoom } from '@/lib/live-room-resolve';
import type { LiveRoomInfo } from '@/lib/types';

/** 直播间解析接口：鉴权、参数校验、force 透传、解析错误状态码映射。解析器本身另有单测，这里 mock 掉。 */

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
  title: '来了',
  living: true,
  streams: [{ format: 'flv', url: 'https://al.flv.huya.com/src/a.flv?x=1', label: 'AL' }],
};

function makeRequest(query: Record<string, string>, authenticated = true): Request {
  const sp = new URLSearchParams(query);
  const headers: Record<string, string> = {};
  if (authenticated) headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  return new Request(`https://local.test/api/live/room?${sp.toString()}`, { headers });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

afterEach(() => {
  resolveMock.mockReset();
});

describe('GET /api/live/room', () => {
  it('未登录 401', async () => {
    const res = await GET(makeRequest({ url: 'https://www.huya.com/100' }, false));
    expect(res.status).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('缺少 url 400', async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('返回解析结果，不缓存；force=1 透传给解析器', async () => {
    resolveMock.mockResolvedValue(INFO);
    const res = await GET(makeRequest({ url: 'https://www.huya.com/uzi', force: '1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(INFO);
    expect(resolveMock).toHaveBeenCalledWith('https://www.huya.com/uzi', { force: true });
  });

  it('解析器的业务错误按其状态码透出（房间不存在 404、非直播间地址 400）', async () => {
    resolveMock.mockRejectedValueOnce(new LiveRoomError('虎牙直播间不存在', 404));
    let res = await GET(makeRequest({ url: 'https://www.huya.com/nobody' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '虎牙直播间不存在' });

    resolveMock.mockRejectedValueOnce(new LiveRoomError('仅支持斗鱼 / 虎牙的直播间地址', 400));
    res = await GET(makeRequest({ url: 'https://example.com/x' }));
    expect(res.status).toBe(400);
  });

  it('未知异常 → 502', async () => {
    resolveMock.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await GET(makeRequest({ url: 'https://www.douyu.com/9999' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('socket hang up');
  });
});
