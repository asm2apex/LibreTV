/** 黄果路由层共用：卡片字段投影与入参校验（与 Go 版各 handler 的字段白名单一致） */

export interface HgCard {
  id: string;
  title: string;
  cover: string;
  totalEpisode: number;
  updateEpisode: number;
  summary?: string;
  wholeCoins?: number;
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? Number(v) || 0 : 0;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function projectCard(m: Record<string, unknown>, extra: { summary?: boolean; wholeCoins?: boolean } = {}): HgCard {
  const card: HgCard = {
    id: toStr(m['id']),
    title: toStr(m['title']),
    cover: toStr(m['cover']),
    totalEpisode: toNum(m['totalEpisode']),
    updateEpisode: toNum(m['updateEpisode']),
  };
  if (extra.summary) card.summary = toStr(m['summary']);
  if (extra.wholeCoins) card.wholeCoins = toNum(m['wholeCoins']);
  return card;
}

export function projectList(m: Record<string, unknown>, extra?: { summary?: boolean; wholeCoins?: boolean }): HgCard[] {
  const out: HgCard[] = [];
  if (Array.isArray(m['list'])) {
    for (const it of m['list']) {
      if (it && typeof it === 'object') out.push(projectCard(it as Record<string, unknown>, extra));
    }
  }
  return out;
}

/** 纯数字入参（页码/类型/tab id）；不合法回退默认值 */
export function digitsOr(v: string | null, def: string): string {
  return v && /^\d{1,8}$/.test(v) ? v : def;
}

/** 拒绝路径穿越与空值（playlet id / sectionId / 图片路径共用） */
export function safeToken(v: string | null): string | null {
  if (!v || v.length > 256 || /[./]/.test(v)) return null;
  return v;
}
