import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 官源解析接口单测：白名单、模板、缓存与强制刷新、厂商失败透出、非 HLS 拒绝、master 穿透。
 * 上游（解析接口 + 清单 CDN）全部 mock fetch；SSRF 校验 mock 掉以免依赖 DNS。
 */

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: true })),
  isValidProxyUrl: vi.fn(() => true),
  isBlockedByDNS: vi.fn(async () => false),
}));

const state = vi.hoisted(() => ({
  /** 解析接口返回体（字符串，便于模拟非 JSON） */
  apiBody: '',
  apiStatus: 200,
  /** 按清单地址返回的正文 */
  playlists: {} as Record<string, { body: string; status?: number; type?: string }>,
  calls: [] as string[],
}));

const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:9.7,', 'seg1.png', '#EXTINF:9.7,', 'https://cdn2.test/seg2.png', '#EXT-X-ENDLIST', ''].join('\n');

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      state.calls.push(url);
      if (url.startsWith('https://parse.test/')) {
        return new Response(state.apiBody, { status: state.apiStatus, headers: { 'content-type': 'application/json' } });
      }
      const bare = url.split('#')[0];
      const hit = state.playlists[bare];
      if (hit) {
        return new Response(hit.body, {
          status: hit.status ?? 200,
          headers: { 'content-type': hit.type ?? 'application/vnd.apple.mpegurl' },
        });
      }
      return new Response('not found', { status: 404 });
    })
  );
}

function makeRequest(pageUrl: string, opts?: { refresh?: boolean; authenticated?: boolean }): Request {
  const sp = new URLSearchParams({ url: pageUrl });
  if (opts?.refresh) sp.set('refresh', '1');
  const headers: Record<string, string> = {};
  if (opts?.authenticated !== false) headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  return new Request(`https://local.test/api/parse?${sp.toString()}`, { headers });
}

/** 每个用例用不同页面地址，避免模块级缓存串台 */
let seq = 0;
const page = () => `https://v.qq.com/x/cover/t${++seq}/e.html`;

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

beforeEach(() => {
  process.env.PARSE_API = 'https://parse.test/api/?key=k&url={url}';
  state.apiStatus = 200;
  state.apiBody = JSON.stringify({ code: 200, url: 'https://cdn.test/live/index.m3u8?tk=1', type: 'hls', msg: '解析成功' });
  state.playlists = { 'https://cdn.test/live/index.m3u8?tk=1': { body: MEDIA } };
  state.calls = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PARSE_API;
});

describe('GET /api/parse', () => {
  it('未登录 401', async () => {
    const res = await GET(makeRequest(page(), { authenticated: false }));
    expect(res.status).toBe(401);
  });

  it('未配置 PARSE_API 返回 501，且不触达任何上游', async () => {
    delete process.env.PARSE_API;
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(501);
    expect(state.calls).toHaveLength(0);
  });

  it('非官方平台页面地址（含媒体直链）一律 400，不替它付费解析', async () => {
    for (const u of ['https://cdn.example.com/index.m3u8', 'https://some-cms.example.com/play/1.html', 'https://v.qq.com/x/index.m3u8', 'not a url']) {
      const res = await GET(makeRequest(u));
      expect(res.status).toBe(400);
    }
    expect(state.calls).toHaveLength(0);
  });

  it('成功：以 mpegurl 返回清单文本，相对分片按上游地址绝对化，模板 {url} 被替换为编码后的页面地址', async () => {
    const p = page();
    const res = await GET(makeRequest(p));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-parse-cache')).toBe('miss');
    const text = await res.text();
    expect(text).toContain('https://cdn.test/live/seg1.png');
    expect(text).toContain('https://cdn2.test/seg2.png');
    expect(text).toContain('#EXT-X-ENDLIST');
    expect(state.calls[0]).toBe(`https://parse.test/api/?key=k&url=${encodeURIComponent(p)}`);
    expect(state.calls).toHaveLength(2);
  });

  it('同一页面地址第二次命中缓存：不再请求解析接口与 CDN；refresh=1 强制重解析', async () => {
    const p = page();
    await GET(makeRequest(p));
    expect(state.calls).toHaveLength(2);

    const hit = await GET(makeRequest(p));
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-parse-cache')).toBe('hit');
    expect(state.calls).toHaveLength(2);

    const refreshed = await GET(makeRequest(p, { refresh: true }));
    expect(refreshed.headers.get('x-parse-cache')).toBe('refresh');
    expect(state.calls).toHaveLength(4);
  });

  it('厂商返回失败 JSON 时透出其 msg（如密钥失效），不缓存', async () => {
    state.apiBody = JSON.stringify({ code: 403, msg: '密钥失效' });
    const p = page();
    const res = await GET(makeRequest(p));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('密钥失效') });
    // 失败不缓存：再次请求仍会打解析接口
    await GET(makeRequest(p));
    expect(state.calls.filter((u) => u.startsWith('https://parse.test/'))).toHaveLength(2);
  });

  it('厂商 msg 本身就是「解析失败」时不叠加同义前缀（此前页面显示为「解析失败：解析失败」）', async () => {
    state.apiBody = JSON.stringify({ code: 404, msg: '解析失败' });
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe('解析失败：解析接口未返回播放地址');
    expect(error.match(/解析失败/g)).toHaveLength(1);
  });

  it('厂商 msg 带「解析失败：」前缀再跟具体原因时，只保留具体原因', async () => {
    state.apiBody = JSON.stringify({ code: 404, msg: '解析失败：资源已下架' });
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: '解析失败：资源已下架' });
  });

  it('解析接口返回非 JSON（如 HTML 拦截页）时给出可读错误', async () => {
    state.apiBody = '<html>IP未授权</html>';
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: '解析接口返回的不是 JSON' });
  });

  it('解析结果不是 HLS 清单（HTML / mp4 直链）时 415', async () => {
    state.playlists['https://cdn.test/live/index.m3u8?tk=1'] = { body: '<html>oops</html>', type: 'text/html' };
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(415);
  });

  it('清单地址 404（直链已过期）时 502', async () => {
    state.playlists['https://cdn.test/live/index.m3u8?tk=1'] = { body: 'gone', status: 404 };
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(502);
  });

  it('master 清单：穿透到带宽最高的变体并返回其 media 清单', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
      'hd/index.m3u8',
      '',
    ].join('\n');
    state.playlists['https://cdn.test/live/index.m3u8?tk=1'] = { body: master };
    state.playlists['https://cdn.test/live/hd/index.m3u8'] = { body: MEDIA };
    const res = await GET(makeRequest(page()));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('https://cdn.test/live/hd/seg1.png');
    expect(state.calls.some((u) => u === 'https://cdn.test/live/hd/index.m3u8')).toBe(true);
    expect(state.calls.some((u) => u.includes('/low/'))).toBe(false);
  });
});
