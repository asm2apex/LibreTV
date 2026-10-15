import { NextResponse } from 'next/server';
import qrcode from 'qrcode-generator';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { cookieSecure } from '@/lib/auth';
import { generateLoginQr, pollLoginQr } from '@/lib/douyu-auth';
import { credentialFromScan, setDouyuCredentialCookie } from '@/lib/douyu-credential';
import type { DouyuQrCreateResponse, DouyuQrPollResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 斗鱼扫码登录。
 * POST：向 passport.douyu.com 申请二维码，返回会话 code 与二维码 SVG（服务端生成，前端内联展示）；
 * GET ?code=：轮询扫码状态。手机确认后服务端换取登录态并写进加密的 httpOnly cookie（见 douyu-credential），
 * 响应只回昵称与 uid，凭证原文不下发。
 */

function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    const session = await generateLoginQr();
    const body: DouyuQrCreateResponse = { code: session.code, expire: session.expire, svg: qrSvg(session.qrUrl) };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return jsonError(`获取斗鱼登录二维码失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const code = new URL(req.url).searchParams.get('code') ?? '';
  if (!/^[0-9a-f]{32}$/.test(code)) return jsonError('非法的二维码 code', 400);
  try {
    const poll = await pollLoginQr(code);
    const body: DouyuQrPollResponse = { state: poll.state, msg: poll.msg };
    if (poll.state === 'success' && poll.login) {
      body.nickname = poll.login.nickname;
      body.uid = poll.login.uid;
    }
    const res = NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
    if (poll.state === 'success' && poll.login) {
      setDouyuCredentialCookie(res, credentialFromScan(poll.login, Date.now()), cookieSecure(req));
    }
    return res;
  } catch (err) {
    return jsonError(`轮询斗鱼登录状态失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
}
