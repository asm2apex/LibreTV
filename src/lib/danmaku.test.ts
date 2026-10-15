import { describe, expect, it } from 'vitest';
import { MAX_DANMAKU_ITEMS, normalizeDanmaku } from './danmaku';

describe('normalizeDanmaku', () => {
  it('厂商数组形态：[秒, 位置, 颜色, 字号, 文本] → 按时间升序的 DanmakuItem，字号丢弃', () => {
    const items = normalizeDanmaku({
      code: 23,
      danum: 3,
      danmuku: [
        [21, 'right', '#fda742', '25px', '第一第一'],
        [1, 'right', '#ffffff', '25px', ' 洛阳前来报到 '],
        [4, 'top', '#CD87FF', '25px', '置顶'],
      ],
    });
    expect(items).toEqual([
      { time: 1, text: '洛阳前来报到', mode: 0, color: '#ffffff' },
      { time: 4, text: '置顶', mode: 1, color: '#cd87ff' },
      { time: 21, text: '第一第一', mode: 0, color: '#fda742' },
    ]);
  });

  it('对象形态与 data 字段同样接受；mode/position、数字与字符串时间均可', () => {
    const items = normalizeDanmaku({
      data: [
        { time: '12.5', text: 'a', mode: 2 },
        { time: 3, text: 'b', position: 'bottom', color: 'ffffff' },
        { time: 7, text: 'c', mode: 'top' },
      ],
    });
    expect(items).toEqual([
      { time: 3, text: 'b', mode: 2, color: '#ffffff' },
      { time: 7, text: 'c', mode: 1 },
      { time: 12.5, text: 'a', mode: 2 },
    ]);
  });

  it('脏条目丢弃：时间非数 / 负数、文本为空或非字符串、颜色非 6 位十六进制不带色', () => {
    const items = normalizeDanmaku({
      danmuku: [
        ['x', 'right', '#ffffff', '25px', '时间非数'],
        [-1, 'right', '#ffffff', '25px', '负时间'],
        [5, 'right', '#ffffff', '25px', '   '],
        [6, 'right', '#ffffff', '25px', 123],
        [8, 'right', 'red', '25px', '颜色名不接受'],
        [9, 'right', '#fff', '25px', '短色值不接受'],
        null,
        'junk',
      ],
    });
    expect(items).toEqual([
      { time: 8, text: '颜色名不接受', mode: 0 },
      { time: 9, text: '短色值不接受', mode: 0 },
    ]);
  });

  it('超长文本截断到 200 字', () => {
    const items = normalizeDanmaku({ danmuku: [[1, 'right', '#ffffff', '25px', 'x'.repeat(500)]] });
    expect(items?.[0].text).toHaveLength(200);
  });

  it('条数超过上限时截断', () => {
    const list = Array.from({ length: MAX_DANMAKU_ITEMS + 50 }, (_, i) => [i, 'right', '#ffffff', '25px', `d${i}`]);
    expect(normalizeDanmaku({ danmuku: list })).toHaveLength(MAX_DANMAKU_ITEMS);
  });

  it('空数组是合法的「无弹幕」，非数组响应返回 null 表示格式不符', () => {
    expect(normalizeDanmaku({ danmuku: [] })).toEqual([]);
    expect(normalizeDanmaku([])).toEqual([]);
    expect(normalizeDanmaku({ code: 403, msg: '密钥失效' })).toBeNull();
    expect(normalizeDanmaku(null)).toBeNull();
    expect(normalizeDanmaku('text')).toBeNull();
  });
});
