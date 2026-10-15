'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import type { DouyuQrCreateResponse } from '@/lib/types';
import { useAuth } from './auth';
import { SectionTitle } from './settings-shared';
import { useToast } from './toast';

/**
 * 斗鱼账号：扫码登录 / 立即续期 / 退出（嵌入直播源面板），以及后台续期守护。
 * 凭证在服务端加密后放进本浏览器的 httpOnly cookie，前端只拿得到昵称、时间点等摘要；
 * 二维码由服务端生成 SVG 内联展示，前端每 2s 轮询扫码状态，手机确认后只需刷新摘要。
 */

export const DOUYU_SESSION_KEY = ['douyuSession'] as const;
const POLL_INTERVAL_MS = 2000;
/** 后台「到点了吗」的询问间隔；是否真的换票由服务端按日程判断，没到点是一次廉价请求 */
const KEEPER_INTERVAL_MS = 60 * 60 * 1000;

type QrPhase = 'idle' | 'loading' | 'waiting' | 'scanned' | 'expired' | 'rejected' | 'error';

function formatAt(ts: number | undefined): string {
  if (!ts) return '未知';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DouyuAccountCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const session = useQuery({ queryKey: DOUYU_SESSION_KEY, queryFn: () => api.douyuSession(), staleTime: 60_000 });
  const [qr, setQr] = useState<(DouyuQrCreateResponse & { createdAt: number }) | null>(null);
  const [phase, setPhase] = useState<QrPhase>('idle');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const startQr = useCallback(async () => {
    setPhase('loading');
    setMessage('');
    setQr(null);
    try {
      const created = await api.douyuQrCreate();
      setQr({ ...created, createdAt: Date.now() });
      setPhase('waiting');
    } catch (err) {
      setPhase('error');
      setMessage(err instanceof Error ? err.message : '获取二维码失败');
    }
  }, []);

  // 轮询扫码状态：成功 / 失效 / 拒绝 / 出错即停；二维码过期由本地时间判定，不再打上游
  useEffect(() => {
    if (!qr) return;
    const controller = new AbortController();
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      controller.abort();
      if (timer) clearInterval(timer);
      timer = null;
    };
    const tick = async () => {
      if (inFlight) return;
      if (Date.now() > qr.createdAt + qr.expire * 1000) {
        stop();
        setPhase('expired');
        return;
      }
      inFlight = true;
      try {
        const r = await api.douyuQrPoll(qr.code, controller.signal);
        if (controller.signal.aborted) return;
        switch (r.state) {
          case 'success':
            stop();
            setQr(null);
            setPhase('idle');
            toast(`斗鱼登录成功：${r.nickname || r.uid || ''}`, 'success');
            void queryClient.invalidateQueries({ queryKey: DOUYU_SESSION_KEY });
            break;
          case 'scanned':
            setPhase('scanned');
            break;
          case 'expired':
            stop();
            setPhase('expired');
            break;
          case 'rejected':
            stop();
            setPhase('rejected');
            setMessage(r.msg || '手机端拒绝了本次登录');
            break;
          default:
            break;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        stop();
        setPhase('error');
        setMessage(err instanceof Error ? err.message : '查询扫码状态失败');
      } finally {
        inFlight = false;
      }
    };
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return stop;
  }, [qr, queryClient, toast]);

  const logout = async () => {
    setBusy(true);
    try {
      const s = await api.douyuLogout();
      queryClient.setQueryData(DOUYU_SESSION_KEY, s);
      toast('已退出斗鱼登录', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : '退出失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const renewNow = async () => {
    setBusy(true);
    try {
      const s = await api.douyuRenew(true);
      queryClient.setQueryData(DOUYU_SESSION_KEY, s);
      if (s.renewed) toast('斗鱼登录态已续期', 'success');
      else toast(`续期未完成：${s.renewError || '稍后会自动重试'}`, 'warning');
    } catch (err) {
      toast(err instanceof Error ? err.message : '续期失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const s = session.data;
  const hasCredential = Boolean(s && (s.loggedIn || s.expired));
  const statusText = session.isLoading
    ? '读取登录状态...'
    : !s || !hasCredential
      ? '未登录'
      : s.expired
        ? `登录态已过期（${s.nickname || s.uid}），取流已退回匿名，请重新扫码`
        : `已登录：${s.nickname || s.uid}`;
  const detailText =
    s && hasCredential && !s.expired
      ? s.needRescan
        ? '自动续期失败，登录凭证可能已失效，请重新扫码'
        : s.canRenew
          ? `上次续期 ${formatAt(s.issuedAt)} · 下次 ${formatAt(s.nextRenewAt)}（每 3 天自动续期）`
          : '扫码时没有拿到长期凭证，约 6 天后需要重新扫码'
      : '';
  const phaseText: Record<QrPhase, string> = {
    idle: '',
    loading: '正在获取二维码...',
    waiting: '打开斗鱼 App 扫码登录（二维码 5 分钟内有效）',
    scanned: '已扫码，请在手机上确认登录',
    expired: '二维码已失效',
    rejected: message || '手机端拒绝了本次登录',
    error: message || '出错了',
  };

  return (
    <section className="mt-6">
      <SectionTitle
        title="斗鱼账号"
        hint="登录后能取到蓝光 / 原画，匿名流约 5 分钟一断的问题也会消失；凭证加密存在本浏览器的 Cookie 里，服务端不保存"
      />
      <div className="bg-card rounded-lg p-3 space-y-2">
        <p className={`text-sm ${s?.needRescan || s?.expired ? 'text-warning' : 'text-content'}`}>{statusText}</p>
        {detailText && <p className="text-xs text-faint">{detailText}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary btn-sm" onClick={() => void startQr()} disabled={phase === 'loading' || busy}>
            {hasCredential ? '重新扫码' : '扫码登录'}
          </button>
          {s?.loggedIn && s.canRenew && (
            <button className="btn-ghost btn-sm" onClick={() => void renewNow()} disabled={busy}>
              立即续期
            </button>
          )}
          {hasCredential && (
            <button className="btn-ghost btn-sm" onClick={() => void logout()} disabled={busy}>
              退出登录
            </button>
          )}
        </div>
        {phase !== 'idle' && (
          <div className="border border-line rounded-lg p-3 bg-chip flex flex-col items-center gap-2">
            {qr && (phase === 'waiting' || phase === 'scanned') && (
              <div
                className="w-44 h-44 rounded bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
                aria-label="斗鱼登录二维码"
                // SVG 由本站服务端生成（qrcode-generator），不是上游内容
                dangerouslySetInnerHTML={{ __html: qr.svg }}
              />
            )}
            <p className="text-xs text-muted text-center">{phaseText[phase]}</p>
            {(phase === 'expired' || phase === 'error' || phase === 'rejected') && (
              <button className="btn-ghost btn-sm" onClick={() => void startQr()}>
                重新获取二维码
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 续期守护（全站常驻，无 UI）：登录验证通过后立即、之后每小时问一次服务端「到点了吗」，
 * 到点由服务端换票并写回 cookie。凭证被判失效时提醒一次，重扫或续期成功后允许再次提醒。
 */
export function DouyuLoginKeeper() {
  const { verified } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const warnedRef = useRef(false);

  useEffect(() => {
    if (!verified) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.douyuRenew();
        if (cancelled) return;
        queryClient.setQueryData(DOUYU_SESSION_KEY, s);
        if (s.needRescan && !warnedRef.current) {
          warnedRef.current = true;
          toast('斗鱼登录凭证已失效，请到「设置 → 直播源 → 斗鱼账号」重新扫码', 'warning');
        }
        if (!s.needRescan) warnedRef.current = false;
      } catch {
        // 网络异常：下个周期再试
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), KEEPER_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [verified, queryClient, toast]);

  return null;
}
