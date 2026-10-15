import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyRenewOutcome,
  credentialFromScan,
  credentialUsable,
  decryptCredential,
  encryptCredential,
  readDouyuCredential,
  sessionStatus,
  type DouyuCredential,
} from './douyu-credential';

/** 凭证 cookie 的加解密、篡改防护、续期策略落账、给前端的摘要不含敏感字段 */

const DAY = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;

const LOGIN = { cookie: 'acf_auth=AUTH; acf_uid=42; dy_did=dev1', ltp0: 'long.ticket', dyDid: 'dev1', uid: '42', nickname: '小明' };

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});
afterEach(() => {
  process.env.PASSWORD = 'test-password';
});

describe('加解密', () => {
  it('往返一致；每次加密随机 IV', () => {
    const c = credentialFromScan(LOGIN, now);
    const a = encryptCredential(c);
    const b = encryptCredential(c);
    expect(a).not.toBe(b);
    expect(decryptCredential(a)).toEqual(c);
    expect(decryptCredential(b)).toEqual(c);
  });

  it('改一个字节 / 换密钥 / 乱串 都当没有凭证', () => {
    const token = encryptCredential(credentialFromScan(LOGIN, now));
    const flipped = token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21);
    expect(decryptCredential(flipped)).toBeNull();
    expect(decryptCredential('not-a-token')).toBeNull();
    expect(decryptCredential('')).toBeNull();
    process.env.PASSWORD = 'another-deployment';
    expect(decryptCredential(token)).toBeNull();
  });

  it('从请求 Cookie 头里取 ftv_douyu（其它 cookie 忽略）', () => {
    const token = encryptCredential(credentialFromScan(LOGIN, now));
    const req = new Request('https://local.test/api/live/room', { headers: { cookie: `ftv_session=abc; ftv_douyu=${token}; other=1` } });
    expect(readDouyuCredential(req)?.uid).toBe('42');
    expect(readDouyuCredential(new Request('https://local.test/', { headers: { cookie: 'ftv_session=abc' } }))).toBeNull();
    expect(readDouyuCredential(new Request('https://local.test/'))).toBeNull();
  });
});

describe('续期策略落账', () => {
  const base: DouyuCredential = credentialFromScan(LOGIN, now);

  it('扫码成功：3 天后续期，未标记重扫', () => {
    expect(base.nextRenewAt).toBe(now + 3 * DAY);
    expect(base.needRescan).toBe(false);
    expect(base.issuedAt).toBe(now);
  });

  it('换票成功：新字段并入、已有设备号不被换掉、昵称解码、日程推后 3 天', () => {
    const later = now + 3 * DAY;
    const next = applyRenewOutcome(base, { kind: 'renewed', fields: { acf_auth: 'NEW', acf_stk: 'STK', dy_did: 'rotated', acf_nickname: encodeURIComponent('新昵称') } }, later);
    expect(next.cookie).toBe(`acf_auth=NEW; acf_nickname=${encodeURIComponent('新昵称')}; acf_stk=STK; acf_uid=42; dy_did=dev1`);
    expect(next.nickname).toBe('新昵称');
    expect(next.issuedAt).toBe(later);
    expect(next.nextRenewAt).toBe(later + 3 * DAY);
    expect(next.ltp0).toBe('long.ticket');
    expect(next.needRescan).toBe(false);
  });

  it('凭证失效：标记重扫，24h 后才再试；再次成功会清掉标记', () => {
    const bad = applyRenewOutcome(base, { kind: 'invalid', error: 'LTP0 过期' }, now + DAY);
    expect(bad.needRescan).toBe(true);
    expect(bad.nextRenewAt).toBe(now + 2 * DAY);
    const good = applyRenewOutcome(bad, { kind: 'renewed', fields: { acf_auth: 'x' } }, now + 2 * DAY);
    expect(good.needRescan).toBe(false);
  });

  it('临时失败：6h 退避；距上次成功超过 6 天仍失败则升级为重扫', () => {
    const soon = applyRenewOutcome(base, { kind: 'temporary', error: 'timeout' }, now + 3 * DAY);
    expect(soon.needRescan).toBe(false);
    expect(soon.nextRenewAt).toBe(now + 3 * DAY + 6 * 60 * 60 * 1000);
    const late = applyRenewOutcome(base, { kind: 'temporary', error: 'timeout' }, now + 7 * DAY);
    expect(late.needRescan).toBe(true);
  });

  it('可用性只看主站 cookie 是否确凿过期：标记重扫但未过期仍可用', () => {
    expect(credentialUsable(base, now + 5 * DAY)).toBe(true);
    expect(credentialUsable({ ...base, needRescan: true }, now + 5 * DAY)).toBe(true);
    expect(credentialUsable(base, now + 8 * DAY)).toBe(false);
  });
});

describe('sessionStatus', () => {
  it('摘要只含非敏感字段', () => {
    const c = credentialFromScan(LOGIN, now);
    const s = sessionStatus(c, now + DAY);
    expect(s).toEqual({ loggedIn: true, nickname: '小明', uid: '42', issuedAt: now, nextRenewAt: now + 3 * DAY, needRescan: false, expired: false, canRenew: true });
    expect(JSON.stringify(s)).not.toMatch(/AUTH|long\.ticket|dev1/);
    expect(sessionStatus(null, now)).toEqual({ loggedIn: false });
  });

  it('过期后 loggedIn=false 且 expired=true；没拿到 LTP0 时 canRenew=false', () => {
    const c = credentialFromScan({ ...LOGIN, ltp0: '' }, now);
    expect(sessionStatus(c, now + 8 * DAY)).toMatchObject({ loggedIn: false, expired: true, canRenew: false });
  });
});
