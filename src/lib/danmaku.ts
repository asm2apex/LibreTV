import type { DanmakuItem } from './types';

/**
 * 弹幕接口响应归一化（服务端执行，浏览器只认 DanmakuItem）。
 *
 * 厂商原始形态：`{ danum, danmuku: [[秒, 位置, 颜色, 字号, 文本], …] }`，位置为 right / top / bottom；
 * 另容忍对象形态 `{ time, text, color, mode | position }` 与 `data` 数组字段，便于换厂商时不改前端。
 * 脏条目（时间非数、文本为空）直接丢弃，颜色只接受 6 位十六进制，文本截断防超长刷屏。
 */

/** 单集弹幕上限：热门剧一集数千条，上万条以上基本是脏数据或刷屏，截断保护播放器渲染 */
export const MAX_DANMAKU_ITEMS = 20_000;
const MAX_TEXT_LEN = 200;

const COLOR_RE = /^#?([0-9a-f]{6})$/i;

function toMode(raw: unknown): DanmakuItem['mode'] {
  if (raw === 1 || raw === '1' || raw === 'top') return 1;
  if (raw === 2 || raw === '2' || raw === 'bottom') return 2;
  return 0;
}

function toColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = COLOR_RE.exec(raw.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

function toTime(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function toItem(entry: unknown): DanmakuItem | undefined {
  let time: number | undefined;
  let text: unknown;
  let mode: DanmakuItem['mode'];
  let color: string | undefined;
  if (Array.isArray(entry)) {
    // [time, position, color, fontSize, text]：字号是厂商播放器的展示参数，本站统一字号不沿用
    [time, mode, color, , text] = [toTime(entry[0]), toMode(entry[1]), toColor(entry[2]), entry[3], entry[4]];
  } else if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    time = toTime(o.time);
    mode = toMode(o.mode ?? o.position);
    color = toColor(o.color);
    text = o.text;
  } else {
    return undefined;
  }
  if (time === undefined || typeof text !== 'string') return undefined;
  const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
  if (!trimmed) return undefined;
  const item: DanmakuItem = { time, text: trimmed, mode };
  if (color) item.color = color;
  return item;
}

/** 响应体里的弹幕数组：优先厂商字段 danmuku，其次 danmaku / data；都没有返回 null（表示格式不符） */
function pickList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['danmuku', 'danmaku', 'data']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return null;
}

/**
 * 归一化为按时间升序的 DanmakuItem 列表。
 * @returns null 表示响应里没有弹幕数组（调用方据此按失败处理并透出厂商 msg）
 */
export function normalizeDanmaku(body: unknown): DanmakuItem[] | null {
  const list = pickList(body);
  if (list === null) return null;
  const items: DanmakuItem[] = [];
  for (const entry of list) {
    const item = toItem(entry);
    if (item) items.push(item);
    if (items.length >= MAX_DANMAKU_ITEMS) break;
  }
  items.sort((a, b) => a.time - b.time);
  return items;
}
