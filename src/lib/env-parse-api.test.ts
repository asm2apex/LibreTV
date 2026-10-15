import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApiUrl, getDanmakuApiTemplate, getParseApiTemplate } from './env-parse-api';

const KEYS = ['PARSE_API', 'DANMAKU_API'] as const;
const originals = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
  vi.restoreAllMocks();
});

describe('getParseApiTemplate / getDanmakuApiTemplate', () => {
  it('未配置、空值、纯空白均视为未配置', () => {
    delete process.env.PARSE_API;
    delete process.env.DANMAKU_API;
    expect(getParseApiTemplate()).toBeUndefined();
    expect(getDanmakuApiTemplate()).toBeUndefined();
    for (const v of ['', '   ']) {
      process.env.PARSE_API = v;
      expect(getParseApiTemplate()).toBeUndefined();
    }
  });

  it('合法模板原样返回（去首尾空白），两把模板互不干扰', () => {
    process.env.PARSE_API = '  https://api.example.com/api/?key=k&url={url} ';
    process.env.DANMAKU_API = 'https://api.example.com/api/?key=d&dm&url=';
    expect(getParseApiTemplate()).toBe('https://api.example.com/api/?key=k&url={url}');
    expect(getDanmakuApiTemplate()).toBe('https://api.example.com/api/?key=d&dm&url=');
  });

  it('非 http(s) 取值告警并忽略，不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PARSE_API = 'file:///etc/passwd';
    process.env.DANMAKU_API = 'javascript:alert(1)';
    expect(getParseApiTemplate()).toBeUndefined();
    expect(getDanmakuApiTemplate()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('buildApiUrl', () => {
  const page = 'https://v.qq.com/x/cover/a/b.html?x=1&y=2';

  it('{url} 占位符替换为编码后的页面地址', () => {
    expect(buildApiUrl('https://api.example.com/api/?key=k&url={url}&t=1', page)).toBe(
      `https://api.example.com/api/?key=k&url=${encodeURIComponent(page)}&t=1`
    );
  });

  it('无占位符时拼在末尾（厂商常见的 &url= 结尾写法）', () => {
    expect(buildApiUrl('https://api.example.com/api/?key=k&url=', page)).toBe(
      `https://api.example.com/api/?key=k&url=${encodeURIComponent(page)}`
    );
  });
});
