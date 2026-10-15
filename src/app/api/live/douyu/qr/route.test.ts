import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { generateLoginQr, pollLoginQr } from '@/lib/douyu-auth';
import { decryptCredential } from '@/lib/douyu-credential';

/** 扫码接口：二维码 SVG、轮询状态透传、成功时写加密 httpOnly cookie 且响应不含凭证原文。协议层 mock 掉。 */

vi.mock('@/lib/douyu-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/douyu-auth')>();
  return { ...actual, generateLoginQr: vi.fn(), pollLoginQr: vi.fn() };
});

const generateMock = vi.mocked(generateLoginQr);
const pollMock = vi.mocked(pollLoginQr);
const CODE = 'b'.repeat(32);

function makeRequest(method: 'GET' | 'POST', query = '', authenticated = true): Request {
  const headers: Record<string, string> = {};
  if (authenticated) headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  return new Request(`https://local.test/api/live/douyu/qr${query}`, { method, headers });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});
afterEach(() => {
  generateMock.mockReset();
  pollMock.mockReset();
});

describe('POST /api/live/douyu/qr', () => {
  it('未登录 401', async () => {
    expect((await POST(makeRequest('POST', '', false))).status).toBe(401);
  });

  it('返回 code、有效期与二维码 SVG', async () => {
    generateMock.mockResolvedValue({ code: CODE, qrUrl: 'https://passport.douyu.com/qr/x', expire: 300 });
    const res = await POST(makeRequest('POST'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expire: number; svg: string };
    expect(body.code).toBe(CODE);
    expect(body.expire).toBe(300);
    expect(body.svg).toContain('<svg');
  });

  it('上游失败 → 502 带原因', async () => {
    generateMock.mockRejectedValue(new Error('斗鱼返回错误: 操作频繁'));
    const res = await POST(makeRequest('POST'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('操作频繁');
  });
});

describe('GET /api/live/douyu/qr', () => {
  it('非法 code 400', async () => {
    expect((await GET(makeRequest('GET', '?code=zzz'))).status).toBe(400);
    expect(pollMock).not.toHaveBeenCalled();
  });

  it('等待 / 已扫码：透传状态，不写 cookie', async () => {
    pollMock.mockResolvedValueOnce({ state: 'waiting', msg: 'w' }).mockResolvedValueOnce({ state: 'scanned' });
    let res = await GET(makeRequest('GET', `?code=${CODE}`));
    expect(await res.json()).toEqual({ state: 'waiting', msg: 'w' });
    expect(res.headers.get('set-cookie')).toBeNull();
    res = await GET(makeRequest('GET', `?code=${CODE}`));
    expect((await res.json()).state).toBe('scanned');
  });

  it('确认成功：写入加密 httpOnly cookie（path /api/live），响应只有昵称与 uid', async () => {
    pollMock.mockResolvedValue({
      state: 'success',
      login: { cookie: 'acf_auth=SECRET; acf_uid=42', ltp0: 'LONG', dyDid: 'dev', uid: '42', nickname: '小明' },
    });
    const res = await GET(makeRequest('GET', `?code=${CODE}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'success', nickname: '小明', uid: '42' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ftv_douyu=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/live');
    expect(setCookie).not.toContain('SECRET');
    expect(setCookie).not.toContain('LONG');
    const token = setCookie.split(';')[0].slice('ftv_douyu='.length);
    const credential = decryptCredential(token);
    expect(credential).toMatchObject({ cookie: 'acf_auth=SECRET; acf_uid=42', ltp0: 'LONG', dyDid: 'dev', uid: '42', nickname: '小明', needRescan: false });
    expect(credential!.nextRenewAt - credential!.issuedAt).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('轮询出错 → 502，不写 cookie', async () => {
    pollMock.mockRejectedValue(new Error('斗鱼登录回调连续 8 跳仍未到达终点'));
    const res = await GET(makeRequest('GET', `?code=${CODE}`));
    expect(res.status).toBe(502);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
