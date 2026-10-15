import { describe, expect, it } from 'vitest';
import {
  canonicalLiveRoomUrl,
  isLiveRoomUrl,
  liveRoomChannel,
  liveRoomPlatformOf,
  parseLiveRoomUrl,
} from './live-room';

describe('parseLiveRoomUrl', () => {
  it.each([
    ['https://www.huya.com/102411', 'huya', '102411'],
    ['http://huya.com/uzi/', 'huya', 'uzi'],
    ['https://m.huya.com/kaerlol?from=share#top', 'huya', 'kaerlol'],
    ['https://www.douyu.com/9999', 'douyu', '9999'],
    ['https://www.douyu.com/topic/pgs10?rid=71415', 'douyu', '71415'],
    ['https://m.douyu.com/yyf', 'douyu', 'yyf'],
    ['  https://WWW.DOUYU.COM/520  ', 'douyu', '520'],
  ])('识别 %s', (url, platform, roomKey) => {
    expect(parseLiveRoomUrl(url)).toEqual({ platform, roomKey });
  });

  it.each([
    'https://www.huya.com/',
    'https://www.huya.com/l',
    'https://www.huya.com/search?q=lol',
    'https://www.huya.com/video/play/1.html',
    'https://www.douyu.com/directory/all',
    'https://www.douyu.com/topic/pgs10',
    'https://www.douyu.com/betard/9999',
    'https://api.douyu.com/9999',
    'https://evil-huya.com/9999',
    'https://www.huya.com.evil.test/9999',
    'https://example.com/list.m3u',
    'rtmp://www.huya.com/9999',
    'not a url',
    '',
  ])('拒绝 %s', (url) => {
    expect(parseLiveRoomUrl(url)).toBeNull();
    expect(isLiveRoomUrl(url)).toBe(false);
    expect(liveRoomPlatformOf(url)).toBeNull();
  });

  it('规范地址固定为 https + www + 数字房间号形式', () => {
    expect(canonicalLiveRoomUrl('huya', '100')).toBe('https://www.huya.com/100');
    expect(canonicalLiveRoomUrl('douyu', '9999')).toBe('https://www.douyu.com/9999');
    expect(liveRoomPlatformOf('http://huya.com/uzi')).toBe('huya');
  });
});

describe('liveRoomChannel', () => {
  it('一个直播间一个频道：主播名为台名、平台为分组、规范地址为标识', () => {
    const channel = liveRoomChannel({
      platform: 'huya',
      roomUrl: 'https://www.huya.com/100',
      roomId: '100',
      owner: 'Uzi',
      title: '来了来了来了',
      avatar: 'https://huyaimg.msstatic.com/a.jpg',
      living: false,
      streams: [],
    });
    expect(channel).toEqual({
      id: 'huya:100',
      name: 'Uzi',
      url: 'https://www.huya.com/100',
      logo: 'https://huyaimg.msstatic.com/a.jpg',
      group: '虎牙',
    });
  });

  it('主播名缺失时以平台 + 房间号兜底', () => {
    const channel = liveRoomChannel({
      platform: 'douyu',
      roomUrl: 'https://www.douyu.com/9999',
      roomId: '9999',
      owner: '',
      title: '',
      living: true,
      streams: [{ format: 'flv', url: 'https://cdn.test/a.flv' }],
    });
    expect(channel.name).toBe('斗鱼 9999');
    expect(channel.group).toBe('斗鱼');
    expect(channel.logo).toBeUndefined();
  });
});
