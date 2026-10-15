import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildParseApiUrl, getParseApiTemplate } from './env-parse-api';

const KEY = 'PARSE_API';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  vi.restoreAllMocks();
});

describe('getParseApiTemplate', () => {
  it('未配置、空值、纯空白均视为未配置', () => {
    delete process.env[KEY];
    expect(getParseApiTemplate()).toBeUndefined();
    for (const v of ['', '   ']) {
      process.env[KEY] = v;
      expect(getParseApiTemplate()).toBeUndefined();
    }
  });

  it('合法模板原样返回（去首尾空白）', () => {
    process.env[KEY] = '  https://api.example.com/api/?key=k&url={url} ';
    expect(getParseApiTemplate()).toBe('https://api.example.com/api/?key=k&url={url}');
  });

  it('非 http(s) 取值告警并忽略，不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[KEY] = 'file:///etc/passwd';
    expect(getParseApiTemplate()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('buildParseApiUrl', () => {
  const page = 'https://v.qq.com/x/cover/a/b.html?x=1&y=2';

  it('{url} 占位符替换为编码后的页面地址', () => {
    expect(buildParseApiUrl('https://api.example.com/api/?key=k&url={url}&t=1', page)).toBe(
      `https://api.example.com/api/?key=k&url=${encodeURIComponent(page)}&t=1`
    );
  });

  it('无占位符时拼在末尾（厂商常见的 &url= 结尾写法）', () => {
    expect(buildParseApiUrl('https://api.example.com/api/?key=k&url=', page)).toBe(
      `https://api.example.com/api/?key=k&url=${encodeURIComponent(page)}`
    );
  });
});
