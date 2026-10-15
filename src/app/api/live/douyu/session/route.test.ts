import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { DouyuLoginInvalidError, refreshLoginCookie } from '@/lib/douyu-auth';
import { credentialFromScan, decryptCredential, encryptCredential, type DouyuCredential } from '@/lib/douyu-credential';

/** 登录态接口：摘要、到点续期（跳过 / 成功 / 失效 / 临时失败都写回 cookie）、退出。换票协议 mock 掉。 */

vi.mock('@/lib/douyu-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/douyu-auth')>();
  return { ...actual, refreshLoginCookie: vi.fn() };
});

const refreshMock = vi.mocked(refreshLoginCookie);
const DAY = 24 * 60 * 60 * 1000;
const LOGIN = { cookie: 'acf_auth=OLD; acf_uid=42; dy_did=dev1', ltp0: 'LONG', dyDid: 'dev1', uid: '42', nickname: '小明' };

function makeRequest(method: 'GET' | 'POST' | 'DELETE', credential?: DouyuCredential, query = ''): Request {
  const cookies = [`${SESSION_COOKIE}=${signSession().token}`];
  if (credential) cookies.push(`ltv_douyu=${encryptCredential(credential)}`);
  return new Request(`https://local.test/api/live/douyu/session${query}`, { method, headers: { cookie: cookies.join('; ') } });
}

function cookieFromResponse(res: Response): DouyuCredential | null {
  const header = res.headers.get('set-cookie') ?? '';
  const m = header.match(/ltv_douyu=([^;]*)/);
  return m ? decryptCredential(m[1]) : null;
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});
afterEach(() => refreshMock.mockReset());

describe('/api/live/douyu/session', () => {
  it('GET：无凭证 → 未登录；有凭证 → 摘要且不含原文', async () => {
    expect(await (await GET(makeRequest('GET'))).json()).toEqual({ loggedIn: false });
    const res = await GET(makeRequest('GET', credentialFromScan(LOGIN, Date.now())));
    const body = await res.json();
    expect(body).toMatchObject({ loggedIn: true, nickname: '小明', uid: '42', canRenew: true });
    expect(JSON.stringify(body)).not.toMatch(/OLD|LONG|dev1/);
  });

  it('POST：未到期不换票，也不写 cookie', async () => {
    const res = await POST(makeRequest('POST', credentialFromScan(LOGIN, Date.now())));
    expect(await res.json()).toMatchObject({ loggedIn: true, renewed: false });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('POST：到期（或 force）换票成功 → 合并字段、日程推后、写回新 cookie', async () => {
    refreshMock.mockResolvedValue({ acf_auth: 'NEW', acf_stk: 'STK', dy_did: 'rotated' });
    const old = { ...credentialFromScan(LOGIN, Date.now() - 4 * DAY), nextRenewAt: Date.now() - DAY };
    const res = await POST(makeRequest('POST', old));
    expect(refreshMock).toHaveBeenCalledWith('LONG', 'dev1');
    expect(await res.json()).toMatchObject({ loggedIn: true, renewed: true, needRescan: false });
    const next = cookieFromResponse(res)!;
    expect(next.cookie).toBe('acf_auth=NEW; acf_stk=STK; acf_uid=42; dy_did=dev1');
    expect(next.nextRenewAt - next.issuedAt).toBe(3 * DAY);

    refreshMock.mockClear();
    const forced = await POST(makeRequest('POST', credentialFromScan(LOGIN, Date.now()), '?force=1'));
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect((await forced.json()).renewed).toBe(true);
  });

  it('POST：凭证失效 → needRescan 并写回；临时失败 → 退避但仍登录', async () => {
    refreshMock.mockRejectedValueOnce(new DouyuLoginInvalidError('LTP0 过期'));
    let res = await POST(makeRequest('POST', credentialFromScan(LOGIN, Date.now()), '?force=1'));
    let body = await res.json();
    expect(body).toMatchObject({ loggedIn: true, renewed: false, needRescan: true });
    expect(body.renewError).toContain('LTP0');
    expect(cookieFromResponse(res)?.needRescan).toBe(true);

    refreshMock.mockRejectedValueOnce(new Error('timeout'));
    res = await POST(makeRequest('POST', credentialFromScan(LOGIN, Date.now()), '?force=1'));
    body = await res.json();
    expect(body).toMatchObject({ loggedIn: true, renewed: false, needRescan: false, renewError: 'timeout' });
    expect(cookieFromResponse(res)!.nextRenewAt).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
  });

  it('POST：没有长期凭证时到期也不换票，提示重扫', async () => {
    const c = { ...credentialFromScan({ ...LOGIN, ltp0: '' }, Date.now()), nextRenewAt: 0 };
    const res = await POST(makeRequest('POST', c));
    expect(await res.json()).toMatchObject({ renewed: false, canRenew: false, renewError: expect.stringContaining('重新扫码') });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('DELETE：清除 cookie', async () => {
    const res = await DELETE(makeRequest('DELETE', credentialFromScan(LOGIN, Date.now())));
    expect(await res.json()).toEqual({ loggedIn: false });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ltv_douyu=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });

  it('未登录站点会话 401', async () => {
    const res = await GET(new Request('https://local.test/api/live/douyu/session'));
    expect(res.status).toBe(401);
  });
});
