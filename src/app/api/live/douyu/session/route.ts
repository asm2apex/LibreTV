import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cookieSecure } from '@/lib/auth';
import { DouyuLoginInvalidError, refreshLoginCookie, shouldRenewNow } from '@/lib/douyu-auth';
import {
  applyRenewOutcome,
  clearDouyuCredentialCookie,
  readDouyuCredential,
  sessionStatus,
  setDouyuCredentialCookie,
  type RenewOutcome,
} from '@/lib/douyu-credential';
import type { DouyuSessionStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * 斗鱼登录态（凭证只在本浏览器的加密 httpOnly cookie 里流转，服务端不保存）：
 * GET 摘要；POST 到点续期（是否到点由 douyu-auth.shouldRenewNow 判断，force=1 立即换票），
 * 续期结果经 applyRenewOutcome 落回 cookie；DELETE 退出登录。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json(sessionStatus(readDouyuCredential(req), Date.now()), { headers: NO_STORE });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const now = Date.now();
  const credential = readDouyuCredential(req);
  if (!credential) return NextResponse.json(sessionStatus(null, now), { headers: NO_STORE });

  const force = new URL(req.url).searchParams.get('force') === '1';
  const due = force || shouldRenewNow(credential.nextRenewAt, credential.issuedAt, now);
  if (!due || !credential.ltp0) {
    const body: DouyuSessionStatus = { ...sessionStatus(credential, now), renewed: false };
    if (due && !credential.ltp0) body.renewError = '没有长期凭证，无法续期，请重新扫码';
    return NextResponse.json(body, { headers: NO_STORE });
  }

  let outcome: RenewOutcome;
  try {
    outcome = { kind: 'renewed', fields: await refreshLoginCookie(credential.ltp0, credential.dyDid) };
  } catch (err) {
    const message = err instanceof Error ? err.message : '续期失败';
    outcome = err instanceof DouyuLoginInvalidError ? { kind: 'invalid', error: message } : { kind: 'temporary', error: message };
  }
  const next = applyRenewOutcome(credential, outcome, now);
  const body: DouyuSessionStatus = {
    ...sessionStatus(next, now),
    renewed: outcome.kind === 'renewed',
    renewError: outcome.kind === 'renewed' ? undefined : outcome.error,
  };
  const res = NextResponse.json(body, { headers: NO_STORE });
  // 失败也要写回：退避日程 / 重扫标记都在 cookie 里
  setDouyuCredentialCookie(res, next, cookieSecure(req));
  return res;
}

export async function DELETE(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const res = NextResponse.json({ loggedIn: false } satisfies DouyuSessionStatus, { headers: NO_STORE });
  clearDouyuCredentialCookie(res);
  return res;
}
