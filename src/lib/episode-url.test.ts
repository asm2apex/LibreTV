import { describe, expect, it } from 'vitest';
import { hasMediaExtension, isPlatformPageUrl, needsParse } from './episode-url';

describe('isPlatformPageUrl', () => {
  it.each([
    'https://v.qq.com/x/cover/mzc00200i3nz40g/u4102pv4j8j.html',
    'https://www.iqiyi.com/v_290syr52zds.html',
    'https://v.youku.com/v_show/id_XNjU1NzA2MDg0MA==.html',
    'https://www.mgtv.com/b/895442/24687585.html',
    'https://www.bilibili.com/bangumi/play/ep6644273?theme=movie',
    'https://b23.tv/abc',
    'https://v.pps.tv/play_3X.html',
    'http://tv.sohu.com/v/x.shtml',
  ])('官方平台页面 %s', (url) => {
    expect(isPlatformPageUrl(url)).toBe(true);
  });

  it('域名精确后缀匹配：形似域名与普通采集站不误判', () => {
    expect(isPlatformPageUrl('https://evil-qq.com/x.html')).toBe(false);
    expect(isPlatformPageUrl('https://qq.com.evil.net/x.html')).toBe(false);
    expect(isPlatformPageUrl('https://cdn.example.com/index.m3u8')).toBe(false);
  });

  it('非法地址与非 http 协议为 false', () => {
    expect(isPlatformPageUrl('not a url')).toBe(false);
    expect(isPlatformPageUrl('ftp://v.qq.com/x')).toBe(false);
  });
});

describe('hasMediaExtension', () => {
  it('按路径后缀识别媒体直链，忽略查询串与锚点', () => {
    expect(hasMediaExtension('https://cdn.example.com/a/index.m3u8?token=1#x')).toBe(true);
    expect(hasMediaExtension('https://cdn.example.com/a/movie.MP4')).toBe(true);
    expect(hasMediaExtension('https://cdn.example.com/a/live.flv')).toBe(true);
    expect(hasMediaExtension('https://v.qq.com/x/cover/a/b.html')).toBe(false);
    expect(hasMediaExtension('https://cdn.example.com/a/play.php?m3u8=1')).toBe(false);
  });
});

describe('needsParse', () => {
  it('平台页面需要解析', () => {
    expect(needsParse('https://v.qq.com/x/cover/mzc00200i3nz40g/u4102pv4j8j.html')).toBe(true);
    expect(needsParse('https://www.bilibili.com/bangumi/play/ep6644273?theme=movie')).toBe(true);
  });

  it('媒体直链不需要解析，即便落在平台域名下', () => {
    expect(needsParse('https://cdn.example.com/index.m3u8')).toBe(false);
    expect(needsParse('https://vod.qq.com/x/index.m3u8')).toBe(false);
  });

  it('非平台的网页地址不走解析（保持原有直接交给播放器的行为）', () => {
    expect(needsParse('https://some-cms.example.com/play/123.html')).toBe(false);
  });

  it('空串与非法地址为 false', () => {
    expect(needsParse('')).toBe(false);
    expect(needsParse('not a url')).toBe(false);
  });
});
