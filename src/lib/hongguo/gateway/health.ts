// 签名通道健康监控：滑动窗口统计上游结果，识别"签名被服务端拒绝"的降级态。
// 判定保守：样本 <8 不判降级（避免启动期误报）；坏率 ≥60% 才降级。
// 降级不是终态——窗口滑动自然恢复（跟修上线后新请求 ok 会稀释坏率）。

export type SignOutcome = 'ok' | 'risk' | 'empty' | 'network';

export interface SignStats {
  total: number;
  ok: number;
  risk: number;
  empty: number;
  network: number;
  degraded: boolean;
}

export class SignHealth {
  private readonly window: SignOutcome[] = [];
  private readonly windowSize: number;
  private readonly minSamples: number;
  private readonly degradeThreshold: number;

  constructor(windowSize = 50, minSamples = 8, degradeThreshold = 0.6) {
    this.windowSize = windowSize;
    this.minSamples = minSamples;
    this.degradeThreshold = degradeThreshold;
  }

  record(o: SignOutcome): void {
    this.window.push(o);
    if (this.window.length > this.windowSize) this.window.shift();
  }

  stats(): SignStats {
    const n = this.window.length;
    const count = (o: SignOutcome) => this.window.filter((x) => x === o).length;
    return {
      total: n,
      ok: count('ok'),
      risk: count('risk'),
      empty: count('empty'),
      network: count('network'),
      degraded: this.degraded(),
    };
  }

  degraded(): boolean {
    const n = this.window.length;
    if (n < this.minSamples) return false;
    const bad = n - this.window.filter((x) => x === 'ok').length;
    return bad / n >= this.degradeThreshold;
  }
}
