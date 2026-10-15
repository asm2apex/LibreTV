import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COOKIE_RENEW_INTERVAL_MS,
  DouyuLoginInvalidError,
  MAIN_SITE_COOKIE_MAX_AGE_MS,
  RENEW_ESCALATE_AFTER_MS,
  RENEW_INVALID_RETRY_BACKOFF_MS,
  RENEW_RETRY_BACKOFF_MS,
  applyDeviceIdPolicy,
  cookieString,
  deviceIdOf,
  generateLoginQr,
  loginCookieKnownExpired,
  parseCookieFields,
  pollLoginQr,
  refreshLoginCookie,
  resolveDouyuRedirect,
  shouldEscalateTempFailure,
  shouldRenewNow,
  stripJsonp,
  verifyLoginCookie,
} from './douyu-auth';

/**
 * 斗鱼扫码 / 续期协议单测：按 bililive-go 抓包形态构造上游响应（含 302 链与中间跳 Set-Cookie），
 * 覆盖风控页（200 + HTML）、空值 Set-Cookie、非斗鱼域名跳转、字段缺失、探针判定等失败形态。
 */

const CODE = 'a'.repeat(32);

type Handler = (url: string, init?: RequestInit) => Response;
const state = vi.hoisted(() => ({ routes: [] as { match: (u: string) => boolean; handler: Handler }[], calls: [] as { url: string; init?: RequestInit }[] }));

function reply(status: number, body = '', headers: [string, string][] = []): Response {
  return new Response(body, { status, headers });
}
function on(prefix: string, handler: Handler) {
  state.routes.push({ match: (u) => u.startsWith(prefix), handler });
}
function cookieHeaderOf(url: string): string {
  const call = state.calls.find((c) => c.url.startsWith(url));
  return ((call?.init?.headers as Record<string, string> | undefined) ?? {}).Cookie ?? '';
}

beforeEach(() => {
  state.routes = [];
  state.calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      state.calls.push({ url, init });
      const route = state.routes.find((r) => r.match(url));
      return route ? route.handler(url, init) : reply(404, 'nope');
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const PROBE = 'https://www.douyu.com/wgapi/livenc/liveweb/follow/top3';

describe('generateLoginQr', () => {
  it('申请二维码：表单 POST，返回 code / url / expire', async () => {
    on('https://passport.douyu.com/scan/generateCode', () => reply(200, JSON.stringify({ error: 0, data: { expire: 300, url: 'https://passport.douyu.com/qr/x', code: CODE } })));
    const s = await generateLoginQr();
    expect(s).toEqual({ code: CODE, qrUrl: 'https://passport.douyu.com/qr/x', expire: 300 });
    const call = state.calls[0];
    expect(call.init?.method).toBe('POST');
    expect(call.init?.body).toBe('client_id=1&isMultiAccount=0');
    expect((call.init?.headers as Record<string, string>).Origin).toBe('https://passport.douyu.com');
  });

  it.each([
    ['业务错误', 200, JSON.stringify({ error: 1, data: '操作频繁' }), /操作频繁/],
    ['风控页 200 + HTML', 200, '<!doctype html><html>verify</html>', /不是预期 JSON/],
    ['HTTP 403', 403, '', /HTTP 403/],
    ['code 形态不对', 200, JSON.stringify({ error: 0, data: { code: 'short', url: 'x' } }), /不完整/],
  ])('%s → 可识别的错误', async (_name, status, body, re) => {
    on('https://passport.douyu.com/scan/generateCode', () => reply(status, body));
    await expect(generateLoginQr()).rejects.toThrow(re);
  });
});

describe('pollLoginQr', () => {
  it.each([
    [-2, 'waiting'],
    [1, 'scanned'],
    [-1, 'expired'],
    [7, 'rejected'],
  ])('error=%s → %s', async (error, expected) => {
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, JSON.stringify({ error, msg: 'm' })));
    expect((await pollLoginQr(CODE)).state).toBe(expected);
  });

  it('非法 code 直接拒绝，不请求上游', async () => {
    await expect(pollLoginQr('bad')).rejects.toThrow(/非法/);
    expect(state.calls).toHaveLength(0);
  });

  it('风控页不能当成「已确认」去换票', async () => {
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, '<html>verify</html>'));
    await expect(pollLoginQr(CODE)).rejects.toThrow(/不是预期 JSON/);
  });

  it('确认成功：轮询响应的 Set-Cookie 给 LTP0，回调 302 链逐跳收集 acf_*，探针通过', async () => {
    on('https://passport.douyu.com/japi/scan/auth', () =>
      reply(200, JSON.stringify({ error: 0, data: { url: 'https://www.douyu.com/api/passport/login?token=once' } }), [
        ['set-cookie', 'LTP0=long.ticket; Path=/; Domain=.douyu.com; HttpOnly'],
        ['set-cookie', 'dy_did=device1; Path=/'],
      ])
    );
    on('https://www.douyu.com/api/passport/login?token=once', () =>
      reply(302, '', [
        ['set-cookie', 'acf_uid=42; Path=/'],
        ['set-cookie', 'acf_auth=AUTH; Path=/; HttpOnly'],
        ['set-cookie', 'acf_stk=; Path=/'],
        ['location', '//www.douyu.com/api/passport/login2'],
      ])
    );
    on('https://www.douyu.com/api/passport/login2', () =>
      reply(200, 'appClient_json_callback({"nickname":"小明","uid":"42"});', [['set-cookie', 'acf_stk=STK; Path=/']])
    );
    on(PROBE, () => reply(200, JSON.stringify({ error: 0, data: { room_list: [] } })));

    const r = await pollLoginQr(CODE);
    expect(r.state).toBe('success');
    expect(r.login).toEqual({
      cookie: 'acf_auth=AUTH; acf_stk=STK; acf_uid=42',
      ltp0: 'long.ticket',
      dyDid: 'device1',
      uid: '42',
      nickname: '小明',
    });
    // 探针带着换到的 cookie 去打
    expect(cookieHeaderOf(PROBE)).toBe('acf_auth=AUTH; acf_stk=STK; acf_uid=42');
  });

  it('昵称 / uid 从 JSONP 拿不到时退回 cookie 里的 acf_nickname / acf_uid', async () => {
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, JSON.stringify({ error: 0, data: { url: 'https://www.douyu.com/api/passport/login?t=1' } })));
    on('https://www.douyu.com/api/passport/login?t=1', () =>
      reply(200, 'cb({});', [
        ['set-cookie', 'acf_uid=99'],
        ['set-cookie', `acf_nickname=${encodeURIComponent('鱼粉')}`],
        ['set-cookie', 'LTP0=in-cookie'],
      ])
    );
    on(PROBE, () => reply(200, JSON.stringify({ error: 0 })));
    const r = await pollLoginQr(CODE);
    expect(r.login?.uid).toBe('99');
    expect(r.login?.nickname).toBe('鱼粉');
    expect(r.login?.ltp0).toBe('in-cookie');
    // LTP0 不混进主站 cookie 串
    expect(r.login?.cookie).not.toContain('LTP0');
  });

  it('探针明确说未登录 → 作废这次扫码；探针是风控页（ambiguous）→ 放行', async () => {
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, JSON.stringify({ error: 0, data: { url: 'https://www.douyu.com/api/passport/login?t=2' } })));
    on('https://www.douyu.com/api/passport/login?t=2', () => reply(200, 'cb({})', [['set-cookie', 'acf_uid=1'], ['set-cookie', 'acf_auth=x']]));
    on(PROBE, () => reply(200, JSON.stringify({ error: -3, msg: '未登录' })));
    await expect(pollLoginQr(CODE)).rejects.toThrow(/未通过登录态校验/);

    state.routes = state.routes.filter((r) => !r.match(PROBE));
    on(PROBE, () => reply(200, '<html>verify</html>'));
    expect((await pollLoginQr(CODE)).state).toBe('success');
  });

  it('跳转到非斗鱼域名 → 拒绝；回调响应缺 url → 报接口变更', async () => {
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, JSON.stringify({ error: 0, data: { url: 'https://www.douyu.com/api/passport/login?t=3' } })));
    on('https://www.douyu.com/api/passport/login?t=3', () => reply(302, '', [['location', 'https://evil.test/steal']]));
    await expect(pollLoginQr(CODE)).rejects.toThrow(/非斗鱼域名/);

    state.routes = [];
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, JSON.stringify({ error: 0, data: {} })));
    await expect(pollLoginQr(CODE)).rejects.toThrow(/缺少回调 URL/);
  });

  it('302 却不给 Location：登录链中断，不能把半截 cookie 当成功', async () => {
    on('https://passport.douyu.com/japi/scan/auth', () => reply(200, JSON.stringify({ error: 0, data: { url: 'https://www.douyu.com/api/passport/login?t=4' } })));
    on('https://www.douyu.com/api/passport/login?t=4', () => reply(302, '', [['set-cookie', 'acf_uid=1']]));
    await expect(pollLoginQr(CODE)).rejects.toThrow(/登录链中断/);
  });
});

describe('verifyLoginCookie（fail-closed）', () => {
  it.each([
    ['已登录', 200, '{"error":0,"data":{"room_list":[]}}', null],
    ['业务码未登录', 200, '{"error":-3,"msg":"未登录"}', 'invalid'],
    ['200 + HTML 风控页', 200, '<html>x</html>', 'temporary'],
    ['200 + JSON 无 error 字段', 200, '{"code":0}', 'temporary'],
    ['服务端 500', 500, '{"error":0}', 'temporary'],
  ])('%s', async (_name, status, body, expected) => {
    on(PROBE, () => reply(status, body));
    const p = verifyLoginCookie('acf_uid=1; acf_auth=x');
    if (expected === null) await expect(p).resolves.toBeUndefined();
    else if (expected === 'invalid') await expect(p).rejects.toBeInstanceOf(DouyuLoginInvalidError);
    else {
      await expect(p).rejects.toThrow();
      await expect(verifyLoginCookie('acf_uid=1')).rejects.not.toBeInstanceOf(DouyuLoginInvalidError);
    }
  });
});

describe('refreshLoginCookie', () => {
  const FULL: [string, string][] = [
    ['acf_uid', '42'], ['acf_auth', 'auth'], ['acf_stk', 'stk'], ['acf_ltkid', 'ltk'],
    ['acf_username', 'uname'], ['acf_biz', 'biz'], ['acf_ct', 'ct'],
  ];
  function installChain(final: [string, string][], finalStatus = 200) {
    on('https://passport.douyu.com/lapi/passport/iframe/safeAuth', () =>
      reply(302, '', [['location', '//www.douyu.com/api/passport/login?loginType=safeAuth&t=once']])
    );
    on('https://www.douyu.com/api/passport/login?loginType=safeAuth', () =>
      reply(finalStatus, 'cb({})', final.map(([k, v]) => ['set-cookie', `${k}=${v}; Path=/`] as [string, string]))
    );
    on(PROBE, () => reply(200, '{"error":0,"data":{"room_list":[]}}'));
  }

  it('safeAuth 302 → 一次性登录地址下发全套 acf_*，每跳带 LTP0 与设备号，探针通过', async () => {
    installChain([...FULL, ['dy_did', 'fresh-did'], ['LTP0', 'should-not-leak']]);
    const fields = await refreshLoginCookie('long.ticket', 'device1');
    expect(fields.acf_uid).toBe('42');
    expect(fields.dy_did).toBe('fresh-did');
    expect(fields.LTP0).toBeUndefined();
    expect(cookieHeaderOf('https://passport.douyu.com/lapi/passport/iframe/safeAuth')).toBe('dy_did=device1; LTP0=long.ticket');
    expect(cookieHeaderOf('https://www.douyu.com/api/passport/login?loginType=safeAuth')).toBe('dy_did=device1; LTP0=long.ticket');
    expect(cookieHeaderOf(PROBE)).toContain('acf_auth=auth');
  });

  it('必需字段缺失 → 凭证失效（需重扫）', async () => {
    installChain(FULL.filter(([k]) => k !== 'acf_ct'));
    await expect(refreshLoginCookie('long.ticket', '')).rejects.toBeInstanceOf(DouyuLoginInvalidError);
  });

  it('换票链终点不是 200（风控 403）→ 临时错误，不判失效', async () => {
    installChain(FULL, 403);
    await expect(refreshLoginCookie('long.ticket', '')).rejects.not.toBeInstanceOf(DouyuLoginInvalidError);
    await expect(refreshLoginCookie('long.ticket', '')).rejects.toThrow(/终点 HTTP 403/);
  });

  it('探针判未登录 → 凭证失效；缺 LTP0 → 直接报错不请求', async () => {
    installChain(FULL);
    state.routes = state.routes.filter((r) => !r.match(PROBE));
    on(PROBE, () => reply(200, '{"error":-3}'));
    await expect(refreshLoginCookie('long.ticket', '')).rejects.toBeInstanceOf(DouyuLoginInvalidError);
    await expect(refreshLoginCookie('   ', '')).rejects.toThrow(/缺少 LTP0/);
  });
});

describe('策略与工具函数', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  it('shouldRenewNow：到点 / 未知日程 / 时钟回拨 / 超有效期 → 续；退避窗口内 → 不续', () => {
    expect(shouldRenewNow(0, 0, now)).toBe(true);
    expect(shouldRenewNow(now - 1, now - DAY, now)).toBe(true);
    expect(shouldRenewNow(now + 2 * DAY, 0, now)).toBe(false);
    // 日程基准落在未来（时钟被改过）
    expect(shouldRenewNow(now + 2 * DAY, now + DAY, now)).toBe(true);
    // 距上次成功超过整个有效期
    expect(shouldRenewNow(now + 2 * DAY, now - 7 * DAY, now)).toBe(true);
    // 最近刚写下的退避日程（24h 内）优先
    expect(shouldRenewNow(now + 6 * 60 * 60 * 1000, now - 7 * DAY, now)).toBe(false);
    expect(COOKIE_RENEW_INTERVAL_MS).toBe(3 * DAY);
    expect(RENEW_RETRY_BACKOFF_MS).toBe(6 * 60 * 60 * 1000);
    expect(RENEW_INVALID_RETRY_BACKOFF_MS).toBe(DAY);
    expect(RENEW_ESCALATE_AFTER_MS).toBe(6 * DAY);
  });

  it('临时失败升级与 cookie 确凿过期的判定', () => {
    expect(shouldEscalateTempFailure(0, now)).toBe(false);
    expect(shouldEscalateTempFailure(now - 5 * DAY, now)).toBe(false);
    expect(shouldEscalateTempFailure(now - 7 * DAY, now)).toBe(true);
    expect(loginCookieKnownExpired(0, now)).toBe(false);
    expect(loginCookieKnownExpired(now - MAIN_SITE_COOKIE_MAX_AGE_MS, now)).toBe(false);
    expect(loginCookieKnownExpired(now - MAIN_SITE_COOKIE_MAX_AGE_MS - 2 * DAY, now)).toBe(true);
  });

  it('设备号策略：已有设备号时挡掉续期签发的新值，没有时补种', () => {
    const fresh = { acf_uid: '1', dy_did: 'new', acf_devid: 'new2' };
    expect(applyDeviceIdPolicy('acf_uid=1; acf_did=old', fresh)).toEqual({ acf_uid: '1' });
    expect(applyDeviceIdPolicy('acf_uid=1', fresh)).toEqual(fresh);
    expect(deviceIdOf('acf_devid=c; acf_did=b; dy_did=a')).toBe('a');
    expect(deviceIdOf('acf_uid=1')).toBeUndefined();
  });

  it('cookie 串解析忽略空值，输出按字段名排序', () => {
    expect(parseCookieFields('b=2; a=1; empty=; novalue; c=x=y')).toEqual({ b: '2', a: '1', c: 'x=y' });
    expect(cookieString({ b: '2', a: '1', z: '' })).toBe('a=1; b=2');
  });

  it('Location 解析：协议相对、相对路径可用，跨域与非 https 拒绝', () => {
    const base = 'https://passport.douyu.com/lapi/passport/iframe/safeAuth';
    expect(resolveDouyuRedirect(base, '//www.douyu.com/api/passport/login?x=1')).toBe('https://www.douyu.com/api/passport/login?x=1');
    expect(resolveDouyuRedirect(base, '/next')).toBe('https://passport.douyu.com/next');
    expect(() => resolveDouyuRedirect(base, 'https://evil.test/x')).toThrow(/非斗鱼域名/);
    expect(() => resolveDouyuRedirect(base, 'http://www.douyu.com/x')).toThrow(/非 HTTPS/);
    expect(() => resolveDouyuRedirect(base, 'https://douyu.com.evil.test/x')).toThrow(/非斗鱼域名/);
  });

  it('stripJsonp', () => {
    expect(stripJsonp('cb({"error":0,"data":{"url":"x"}});')).toBe('{"error":0,"data":{"url":"x"}}');
    expect(stripJsonp('no json here')).toBe('');
  });
});
