import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/** 弹幕接口单测：白名单、模板、归一化、缓存、厂商失败透出。上游 mock fetch，SSRF mock 掉以免依赖 DNS。 */

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: true })),
  isValidProxyUrl: vi.fn(() => true),
  isBlockedByDNS: vi.fn(async () => false),
}));

const state = vi.hoisted(() => ({ body: '', status: 200, calls: [] as string[] }));

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      state.calls.push(String(input));
      return new Response(state.body, { status: state.status, headers: { 'content-type': 'application/json' } });
    })
  );
}

function makeRequest(pageUrl: string, authenticated = true): Request {
  const sp = new URLSearchParams({ url: pageUrl });
  const headers: Record<string, string> = {};
  if (authenticated) headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  return new Request(`https://local.test/api/danmaku?${sp.toString()}`, { headers });
}

let seq = 0;
const page = () => `https://www.iqiyi.com/v_dm${++seq}.html`;

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

beforeEach(() => {
  process.env.DANMAKU_API = 'https://dm.test/api/?key=k&dm&url=';
  state.status = 200;
  state.body = JSON.stringify({
    code: 23,
    danum: 2,
    danmuku: [
      [15, 'right', '#ffffff', '25px', '来了'],
      [4, 'top', '#cd87ff', '25px', '洛阳前来报到'],
    ],
  });
  state.calls = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DANMAKU_API;
});

describe('GET /api/danmaku', () => {
  it('未登录 401；未配置 DANMAKU_API 501；非平台地址 400，均不触达上游', async () => {
    expect((await GET(makeRequest(page(), false))).status).toBe(401);
    delete process.env.DANMAKU_API;
    expect((await GET(makeRequest(page()))).status).toBe(501);
    process.env.DANMAKU_API = 'https://dm.test/api/?key=k&dm&url=';
    expect((await GET(makeRequest('https://cdn.example.com/a.m3u8'))).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it('成功：归一化为按时间升序的条目，模板无占位符时页面地址拼在末尾', async () => {
    const p = page();
    const res = await GET(makeRequest(p));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-danmaku-cache')).toBe('miss');
    expect(res.headers.get('cache-control')).toContain('no-store');
    await expect(res.json()).resolves.toEqual({
      count: 2,
      items: [
        { time: 4, text: '洛阳前来报到', mode: 1, color: '#cd87ff' },
        { time: 15, text: '来了', mode: 0, color: '#ffffff' },
      ],
    });
    expect(state.calls).toEqual([`https://dm.test/api/?key=k&dm&url=${encodeURIComponent(p)}`]);
  });

  it('同一页面第二次命中缓存，不再请求上游', async () => {
    const p = page();
    await GET(makeRequest(p));
    const hit = await GET(makeRequest(p));
    expect(hit.headers.get('x-danmaku-cache')).toBe('hit');
    expect(state.calls).toHaveLength(1);
  });

  it('空弹幕是合法结果（count 0）并缓存', async () => {
    state.body = JSON.stringify({ danum: 0, danmuku: [] });
    const p = page();
    const res = await GET(makeRequest(p));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0, items: [] });
    await GET(makeRequest(p));
    expect(state.calls).toHaveLength(1);
  });

  it('厂商失败 JSON 透出 msg，非 JSON 给可读错误，均不缓存', async () => {
    state.body = JSON.stringify({ code: 403, msg: '密钥失效' });
    const p = page();
    const res = await GET(makeRequest(p));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('密钥失效') });
    state.body = '<html>拦截页</html>';
    const bad = await GET(makeRequest(p));
    expect(bad.status).toBe(502);
    await expect(bad.json()).resolves.toMatchObject({ error: '弹幕接口返回的不是 JSON' });
    expect(state.calls).toHaveLength(2);
  });

  it('上游 HTTP 非 2xx 返回 502', async () => {
    state.status = 500;
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(502);
  });
});
