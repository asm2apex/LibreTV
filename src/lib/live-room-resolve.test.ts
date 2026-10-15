import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRoomError, douyuSign, huyaAntiCode, resolveLiveRoom } from './live-room-resolve';

/**
 * 直播间取流单测：虎牙页面解析 + anti-code、斗鱼 betard / 签名脚本 / getH5Play、
 * 别名跳转、未开播、房间不存在、缓存与 force。上游全部 mock fetch；SSRF 校验 mock 掉以免依赖 DNS。
 * 模块级缓存跨用例存活，每个用例用不同房间号。
 */

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: true })),
  isValidProxyUrl: vi.fn(() => true),
  isBlockedByDNS: vi.fn(async () => false),
}));

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

// —— 虎牙页面夹具 ——

/** 签名模板：平台给的是 base64，占位 $0 用户 id / $1 流名 / $2 摘要 / $3 wsTime */
const FM_TEMPLATE = 'DWq8BcJ3h6DJt6TY_$0_$1_$2_$3';
const ANTI_CODE = new URLSearchParams({
  wsSecret: 'placeholder',
  wsTime: '68ef3a1c',
  fm: Buffer.from(FM_TEMPLATE, 'utf8').toString('base64'),
  ctype: 'huya_live',
  fs: 'bgct',
  t: '100',
}).toString();

function huyaCdn(cdn: string, host: string) {
  return {
    sCdnType: cdn,
    sStreamName: '2368274334-2368274334-A-0-1-imgplus',
    sFlvUrl: `http://${host}.flv.huya.com/src`,
    sFlvUrlSuffix: 'flv',
    sFlvAntiCode: ANTI_CODE,
    sHlsUrl: `http://${host}.hls.huya.com/src`,
    sHlsUrlSuffix: 'm3u8',
    sHlsAntiCode: ANTI_CODE,
  };
}

function huyaPage(opts: { on: boolean; profileRoom: number; nick?: string; cdns?: ReturnType<typeof huyaCdn>[] }): string {
  const roomData = JSON.stringify({ type: 'NORMAL', state: opts.on ? 'ON' : 'OFF', isOn: opts.on, introduction: '峡谷已前十 顶级新号' });
  const profile = JSON.stringify({ nick: opts.nick ?? '小超梦ovo', avatar: 'http://huyaimg.msstatic.com/avatar/a_180_135.jpg', profileRoom: opts.profileRoom, host: 'xiaochaomeng' });
  const stream = JSON.stringify({
    data: [{ gameLiveInfo: { profileRoom: opts.profileRoom }, gameStreamInfoList: opts.cdns ?? [huyaCdn('AL', 'al'), huyaCdn('TX', 'tx'), huyaCdn('HS', 'hs')] }],
    vMultiStreamInfo: [{ sDisplayName: '蓝光8M', iBitRate: 0 }],
  });
  return [
    '<!doctype html><html><head><script>',
    `var TT_ROOM_DATA = ${roomData};`,
    `var TT_PROFILE_INFO = ${profile};`,
    '</script></head><body><script>',
    `var hyPlayerConfig = { html5: 1, WEBYYHOST: "www.huya.com", stream: ${stream}};`,
    '</script></body></html>',
  ].join('\n');
}

// —— 斗鱼夹具 ——

/** 模拟 homeH5Enc 下发的签名脚本：形态与真实脚本一致（依赖 CryptoJS.MD5，返回查询串） */
const DOUYU_JS =
  'var vdwdae325w_64we = 1; function ub98484234(rid, did, tt) {' +
  ' var v = "220120261015"; var sign = CryptoJS.MD5(rid + did + tt + v).toString();' +
  ' return "v=" + v + "&did=" + did + "&tt=" + tt + "&sign=" + sign; }';

function douyuRoom(rid: number, showStatus: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    room: {
      room_id: rid,
      room_name: '陪伴每一天！',
      owner_name: 'yyfyyf',
      nickname: 'yyfyyf',
      show_status: showStatus,
      videoLoop: 0,
      avatar: { big: 'https://apic.douyucdn.cn/big.jpg', middle: 'https://apic.douyucdn.cn/middle.jpg' },
      ...extra,
    },
  });
}

const state = vi.hoisted(() => ({
  routes: new Map<string, (init?: RequestInit) => Response>(),
  calls: [] as { url: string; init?: RequestInit }[],
}));

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}
function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  state.routes.clear();
  state.calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      state.calls.push({ url, init });
      const handler = state.routes.get(url);
      return handler ? handler(init) : new Response('not found', { status: 404 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('虎牙', () => {
  it('开播：别名地址解析成数字房间号，前两条线路各给 FLV + HLS，地址升级为 https', async () => {
    state.routes.set('https://www.huya.com/xiaochaomeng', () => html(huyaPage({ on: true, profileRoom: 257085 })));
    const info = await resolveLiveRoom('https://huya.com/xiaochaomeng');
    expect(info).toMatchObject({
      platform: 'huya',
      roomId: '257085',
      roomUrl: 'https://www.huya.com/257085',
      owner: '小超梦ovo',
      title: '峡谷已前十 顶级新号',
      avatar: 'https://huyaimg.msstatic.com/avatar/a_180_135.jpg',
      living: true,
    });
    expect(info.streams.map((s) => `${s.label}:${s.format}`)).toEqual(['AL:flv', 'AL:hls', 'TX:flv', 'TX:hls']);
    for (const s of info.streams) expect(s.url.startsWith('https://')).toBe(true);
    expect(info.streams[0].url).toMatch(/^https:\/\/al\.flv\.huya\.com\/src\/2368274334-2368274334-A-0-1-imgplus\.flv\?wsSecret=[0-9a-f]{32}&wsTime=68ef3a1c&/);
    expect(info.streams[1].url).toMatch(/^https:\/\/al\.hls\.huya\.com\/src\/.+\.m3u8\?wsSecret=/);
  });

  it('anti-code：wsSecret = md5(模板填入 uid / 流名 / md5(seqid|ctype|t) / wsTime)', () => {
    const query = huyaAntiCode(ANTI_CODE, 1234567890123, 'stream-x');
    const q = new URLSearchParams(query);
    expect(q.get('u')).toBe('1234567890123');
    expect(q.get('sdk_sid')).toBe('1234567890123');
    expect(q.get('ctype')).toBe('huya_live');
    expect(q.get('fs')).toBe('bgct');
    expect(q.get('t')).toBe('100');
    expect(q.get('codec')).toBe('264');
    const seqid = q.get('seqid')!;
    expect(Number(seqid)).toBeGreaterThan(1234567890123);
    const ss = md5(`${seqid}|huya_live|100`);
    const expected = md5(FM_TEMPLATE.replace('$0', '1234567890123').replace('$1', 'stream-x').replace('$2', ss).replace('$3', '68ef3a1c'));
    expect(q.get('wsSecret')).toBe(expected);
  });

  it('未开播：给出主播与标题，不给流', async () => {
    state.routes.set('https://www.huya.com/521000', () => html(huyaPage({ on: false, profileRoom: 521000, nick: '卡尔', cdns: [] })));
    const info = await resolveLiveRoom('https://www.huya.com/521000');
    expect(info.living).toBe(false);
    expect(info.streams).toEqual([]);
    expect(info.owner).toBe('卡尔');
  });

  it('开播但页面没有流列表：按页面结构变化报错而不是静默给空流', async () => {
    state.routes.set('https://www.huya.com/700001', () => html(huyaPage({ on: true, profileRoom: 700001, cdns: [] })));
    await expect(resolveLiveRoom('https://www.huya.com/700001')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('流地址') });
  });

  it('不存在的房间：页面 200 但 profileRoom 为 0 → 404', async () => {
    state.routes.set('https://www.huya.com/nobody', () => html(huyaPage({ on: false, profileRoom: 0, nick: '', cdns: [] })));
    await expect(resolveLiveRoom('https://www.huya.com/nobody')).rejects.toMatchObject({ status: 404 });
  });

  it('页面结构变化（找不到 TT_ROOM_DATA）→ 502 并提示适配', async () => {
    state.routes.set('https://www.huya.com/700002', () => html('<html><body>new layout</body></html>'));
    await expect(resolveLiveRoom('https://www.huya.com/700002')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('结构') });
  });
});

describe('斗鱼', () => {
  it('开播：betard → homeH5Enc 签名 → getH5Play，FLV 地址与签名参数正确', async () => {
    state.routes.set('https://www.douyu.com/betard/9999', () => json(douyuRoom(9999, 1)));
    state.routes.set('https://www.douyu.com/swf_api/homeH5Enc?rids=9999', () => json(JSON.stringify({ error: 0, data: { room9999: DOUYU_JS } })));
    state.routes.set('https://www.douyu.com/lapi/live/getH5Play/9999', () =>
      json(JSON.stringify({ error: 0, msg: 'ok', data: { rtmp_url: 'http://huos1a.douyucdn2.cn/live', rtmp_live: '9999rMfVyoBTjV0x_900.flv?wsAuth=a1&token=web-h5-0-', rtmp_cdn: 'hw-h5' } }))
    );
    const info = await resolveLiveRoom('https://www.douyu.com/9999');
    expect(info).toMatchObject({
      platform: 'douyu',
      roomId: '9999',
      roomUrl: 'https://www.douyu.com/9999',
      owner: 'yyfyyf',
      title: '陪伴每一天！',
      avatar: 'https://apic.douyucdn.cn/middle.jpg',
      living: true,
      streams: [{ format: 'flv', url: 'https://huos1a.douyucdn2.cn/live/9999rMfVyoBTjV0x_900.flv?wsAuth=a1&token=web-h5-0-', label: 'hw-h5' }],
    });

    const play = state.calls.find((c) => c.url.endsWith('/getH5Play/9999'))!;
    expect(play.init?.method).toBe('POST');
    const headers = play.init?.headers as Record<string, string>;
    expect(headers.Origin).toBe('https://www.douyu.com');
    expect(headers.Referer).toBe('https://www.douyu.com/9999');
    const body = new URLSearchParams(String(play.init?.body));
    expect(body.get('v')).toBe('220120261015');
    expect(body.get('rate')).toBe('0');
    expect(body.get('hevc')).toBe('0');
    // sign 由 vm 内的 CryptoJS 垫片算出：与脚本约定的 md5(rid+did+tt+v) 一致
    expect(body.get('sign')).toBe(md5(`9999${body.get('did')}${body.get('tt')}220120261015`));
    expect(body.get('did')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('未开播：只打 betard，不取签名脚本', async () => {
    state.routes.set('https://www.douyu.com/betard/520', () => json(douyuRoom(520, 2)));
    const info = await resolveLiveRoom('https://www.douyu.com/520');
    expect(info.living).toBe(false);
    expect(info.streams).toEqual([]);
    expect(state.calls.some((c) => c.url.includes('homeH5Enc'))).toBe(false);
  });

  it('录像轮播（videoLoop=1）不算开播', async () => {
    state.routes.set('https://www.douyu.com/betard/521', () => json(douyuRoom(521, 1, { videoLoop: 1 })));
    const info = await resolveLiveRoom('https://www.douyu.com/521');
    expect(info.living).toBe(false);
  });

  it('别名地址：跟随 302 落到数字房间号', async () => {
    state.routes.set('https://www.douyu.com/yyf', () => new Response(null, { status: 302, headers: { location: '/45977' } }));
    state.routes.set('https://www.douyu.com/45977', () => html('<html>room</html>'));
    state.routes.set('https://www.douyu.com/betard/45977', () => json(douyuRoom(45977, 2)));
    const info = await resolveLiveRoom('https://www.douyu.com/yyf');
    expect(info.roomId).toBe('45977');
    expect(info.roomUrl).toBe('https://www.douyu.com/45977');
  });

  it('别名地址不跳转时从页面脚本提取 room_id', async () => {
    state.routes.set('https://www.douyu.com/alias2', () => html('<html><script>$ROOM.room_id = 606;</script></html>'));
    state.routes.set('https://www.douyu.com/betard/606', () => json(douyuRoom(606, 2)));
    const info = await resolveLiveRoom('https://www.douyu.com/alias2');
    expect(info.roomId).toBe('606');
  });

  it('betard 返回 HTML（房间不存在）→ 404', async () => {
    state.routes.set('https://www.douyu.com/betard/1', () => html('<!DOCTYPE html><html>error</html>'));
    await expect(resolveLiveRoom('https://www.douyu.com/1')).rejects.toMatchObject({ status: 404 });
  });

  it('getH5Play 返回业务错误 → 透出厂商 msg', async () => {
    state.routes.set('https://www.douyu.com/betard/7001', () => json(douyuRoom(7001, 1)));
    state.routes.set('https://www.douyu.com/swf_api/homeH5Enc?rids=7001', () => json(JSON.stringify({ error: 0, data: { room7001: DOUYU_JS } })));
    state.routes.set('https://www.douyu.com/lapi/live/getH5Play/7001', () => json(JSON.stringify({ error: 102, msg: '房间未开播' })));
    await expect(resolveLiveRoom('https://www.douyu.com/7001')).rejects.toMatchObject({ status: 502, message: '斗鱼取流失败：房间未开播' });
  });

  it('签名脚本形态变化：缺少 ub98484234 或返回异常结果都报可识别的错误', () => {
    expect(() => douyuSign('var x = 1;', '9999')).toThrow(LiveRoomError);
    expect(() => douyuSign('var x = 1;', '9999')).toThrow(/格式已变化/);
    expect(() => douyuSign('function ub98484234(a, b, c) { return 42; }', '9999')).toThrow(/意外结果/);
    expect(() => douyuSign('function ub98484234(a, b, c) { while (true) {} }', '9999')).toThrow(/执行失败/);
  });
});

describe('通用', () => {
  it('非直播间地址 → 400', async () => {
    await expect(resolveLiveRoom('https://example.com/list.m3u')).rejects.toMatchObject({ status: 400 });
  });

  it('60s 内重复解析命中缓存，force 跳过缓存', async () => {
    let hits = 0;
    state.routes.set('https://www.douyu.com/betard/8001', () => {
      hits++;
      return json(douyuRoom(8001, 2));
    });
    await resolveLiveRoom('https://www.douyu.com/8001');
    await resolveLiveRoom('https://www.douyu.com/8001');
    expect(hits).toBe(1);
    await resolveLiveRoom('https://www.douyu.com/8001', { force: true });
    expect(hits).toBe(2);
  });

  it('同一房间的并发请求只打平台一次', async () => {
    let hits = 0;
    state.routes.set('https://www.douyu.com/betard/8002', () => {
      hits++;
      return json(douyuRoom(8002, 2));
    });
    await Promise.all([resolveLiveRoom('https://www.douyu.com/8002'), resolveLiveRoom('https://www.douyu.com/8002')]);
    expect(hits).toBe(1);
  });
});
