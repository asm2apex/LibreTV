// App API 客户端（fqnovel 通道，需签名）。规格：docs/protocol/02-api-and-decryption.md
// §1.2/§2/§3/§8/§9.2；签名头语义见 docs/protocol/01-signing.md。
// 签名器与 fetch 依赖注入——sign 模块（src/sign/）落地后由网关装配真实实现。
//
// 红果语境常量（规格 01 §1）：version_code 71332（7.1.3.32）、license 1588093228、
// SDK 0x04060400、UA com.phoenix.read/71332 (25053RT47C)。
//
// 设备策略（规格 02 §8.3 裁决）：目录类 = 稳定 device_id（持久化）+ iid=0；
// 取流类 = 每次现生成随机设备对（同设备对同 vid 仅签发一次），vid 级会话缓存。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildQuery, cleanUrl, fetchWithRetry, Throttle, UA_APP_HONGGUO } from '../util/http';
import { DomainPool } from './domains';
import { SignHealth } from '../gateway/health';
import { parseJsonLoose } from '../util/router-data';
import { decryptSpadeUrl } from '../crypto/urlcipher';

// ---- 依赖注入接口（与 src/sign/index.ts 结构兼容） ----
export interface SignInput {
  url: string;
  body?: string | null;
  cookie?: string | null;
  deviceId: string;
  parameter?: number;
}
export interface SignOptions {
  context?: 'hongguo' | 'fanqie';
  khronos?: number;
  random?: Record<string, unknown>;
  stubLadonArgus?: boolean;
}
export type SignFn = (input: SignInput, opts?: SignOptions) => Record<string, string>;
export type BranchFn = (url: string, body: string | null, khronos: number) => 0 | 1 | 2;

export interface FetchLike {
  (url: string, init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    retries?: number;
  }): Promise<{ ok: boolean; status: number; headers?: Record<string, string>; text(): Promise<string> }>;
}

// ---- 常量 ----
const DEVICE_PROFILE = {
  device_type: '25053RT47C',
  device_brand: 'Redmi',
  resolution: '1280*2772',
  dpi: '520',
  os_api: '36',
  os_version: '16',
  host_abi: 'arm64-v8a',
  channel: 'update_64',
};
const APP = {
  aid: '8662',
  app_name: 'novelread',
  version_code: '71332',
  version_name: '7.1.3.32',
  manifest_version_code: '71332',
  update_version_code: '71332',
};
const API_HOSTS = ['fqnovel.com', 'snssdk.com'];
const VOD_HOSTS = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'];

export class RiskError extends Error {
  readonly code: number;
  readonly retryAfterSec?: number;
  constructor(message: string, code: number, retryAfterSec?: number) {
    super(message);
    this.name = 'RiskError';
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}
export class EmptyModelError extends Error {
  readonly vid: string;
  constructor(vid: string) {
    super(`video_model 为空（vid=${vid}）`);
    this.name = 'EmptyModelError';
    this.vid = vid;
  }
}

// ---- 类型 ----
export interface AppSearchItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeCnt: number;
}
export interface AppEpisode {
  vid: string;
  index: number;
  title: string | null;
  durationSec: number;
}
export interface AppDetail {
  seriesId: string;
  title: string;
  intro: string;
  cover: string;
  episodeCnt: number;
  categories: string[];
  episodes: AppEpisode[];
}
export interface ResolvedStream {
  vid: string;
  definition: string;
  codec: string;
  mainUrl: string;
  backupUrls: string[];
  spadeA: string;
  size?: number;
  width?: number;
  height?: number;
}

interface DevicePair {
  deviceId: string;
  iid: string;
  cdid: string;
}

function rand16(): string {
  // 10^15 + 48bit 随机（规格 01 §5 [A] 策略），恒 16 位
  return String(10 ** 15 + Math.floor(Math.random() * 2 ** 48));
}

// ---- 客户端 ----
export class AppSource {
  private readonly throttle: Throttle;
  private readonly pool = new DomainPool();
  /** 签名通道健康（网关 /health 暴露 + 降级判定用） */
  readonly health = new SignHealth();
  private readonly modelCache = new Map<string, ResolvedStream[]>(); // vid → 各档位流
  private stable: DevicePair | null = null;

  private readonly deps: {
    sign: SignFn;
    branchOf: BranchFn;
    fetchImpl?: FetchLike;
    dataDir?: string;
    throttleMs?: number;
  };

  constructor(
    deps: {
      sign: SignFn;
      branchOf: BranchFn;
      fetchImpl?: FetchLike;
      dataDir?: string;
      throttleMs?: number;
    },
  ) {
    this.deps = deps;
    this.throttle = new Throttle(deps.throttleMs ?? 600);
  }

  private get fetchImpl(): FetchLike {
    return (
      this.deps.fetchImpl ??
      (async (url, init) => {
        const res = await fetchWithRetry(url, init);
        const ra = res.headers.get('retry-after');
        return { ok: res.ok, status: res.status, headers: ra ? { 'retry-after': ra } : undefined, text: () => res.text() };
      })
    );
  }

  /** 目录类稳定设备（持久化到 data/device.json；iid=0，规格 02 §8.2-1）。 */
  private async stableDevice(): Promise<DevicePair> {
    if (this.stable) return this.stable;
    const dir = this.deps.dataDir ?? path.resolve('data');
    const file = path.join(dir, 'device.json');
    let saved: { deviceId?: string; cdid?: string } = {};
    if (existsSync(file)) {
      try {
        saved = JSON.parse(await readFile(file, 'utf8')) as typeof saved;
      } catch {
        // 损坏则重建
      }
    }
    const deviceId = saved.deviceId ?? rand16();
    const cdid = saved.cdid ?? randomUUID();
    if (saved.deviceId !== deviceId || saved.cdid !== cdid) {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify({ deviceId, cdid }, null, 2));
    }
    this.stable = { deviceId, iid: '0', cdid };
    return this.stable;
  }

  /** 取流类随机设备对（规格 02 §8.3）。 */
  private static randomDevice(): DevicePair {
    return { deviceId: rand16(), iid: rand16(), cdid: randomUUID() };
  }

  /** 设备参数（不含时间戳）。端点参数插在本段之后、ts/_rticket 之前（规格 02 §9.2：ts/_rticket 收尾）。 */
  private baseQuery(dev: DevicePair): Array<[string, string]> {
    return [
      ['ac', 'wifi'],
      ['channel', DEVICE_PROFILE.channel],
      ['aid', APP.aid],
      ['app_name', APP.app_name],
      ['version_code', APP.version_code],
      ['version_name', APP.version_name],
      ['manifest_version_code', APP.manifest_version_code],
      ['update_version_code', APP.update_version_code],
      ['device_platform', 'android'],
      ['os', 'android'],
      ['ssmix', 'a'],
      ['device_type', DEVICE_PROFILE.device_type],
      ['device_brand', DEVICE_PROFILE.device_brand],
      ['language', 'zh'],
      ['os_api', DEVICE_PROFILE.os_api],
      ['os_version', DEVICE_PROFILE.os_version],
      ['resolution', DEVICE_PROFILE.resolution],
      ['dpi', DEVICE_PROFILE.dpi],
      ['host_abi', DEVICE_PROFILE.host_abi],
      ['compliance_status', '0'],
      ['need_personal_recommend', '1'],
      ['player_so_load', '1'],
      ['is_android_pad_screen', '0'],
      ['iid', dev.iid],
      ['device_id', dev.deviceId],
      ['cdid', dev.cdid],
    ];
  }

  /**
   * 签名请求执行器：branch 1 预检抖动（规格 01 §6.2，≤32 次）、空 body 重试一次
   * （规格 02 §9.2）、风控码分类（规格 02 §8.4）。
   */
  private async appFetch(opts: {
    path: string;
    method: 'GET' | 'POST';
    role: 'catalog' | 'stream';
    endpointParams?: Array<[string, string]>;
    body?: unknown;
    device: DevicePair;
  }): Promise<Record<string, unknown>> {
    const bodyStr = opts.body === undefined ? null : JSON.stringify(opts.body);
    const khronos = Math.floor(Date.now() / 1000);

    // 域名级重试：网络层故障冷却 15s 换域最多 2 次；业务错误（RiskError）直接抛
    let lastNetErr: unknown = null;
    for (let domainAttempt = 0; domainAttempt < 2; domainAttempt++) {
      const host = this.pool.pick(opts.role);
      let rticket = Date.now() + Math.floor(Math.random() * 400);

      // branch 1 抖动：_rticket 在 query 里，抖动必然换分支（规格 01 §6.2）
      let url: string;
      for (let i = 0; i < 32; i++) {
        const query = buildQuery([
          ...this.baseQuery(opts.device),
          ...(opts.endpointParams ?? []),
          ['ts', String(khronos)],
          ['_rticket', String(rticket)],
        ]);
        url = `${host}${opts.path}?${query}`;
        if (this.deps.branchOf(url, bodyStr, khronos) !== 1) break;
        rticket += 1 + Math.floor(Math.random() * 3);
      }

      const signHeaders = this.deps.sign(
        { url: url!, body: bodyStr, deviceId: opts.device.deviceId, parameter: 320 },
        { context: 'hongguo', khronos },
      );
      const headers: Record<string, string> = {
        'User-Agent': UA_APP_HONGGUO,
        Accept: 'application/json; charset=utf-8,application/x-protobuf',
        'Content-Type': 'application/json; charset=UTF-8',
        'x-xs-from-web': '0',
        'x-ss-req-ticket': String(rticket),
        'x-tt-request-tag': 't=0;n=0',
        'sdk-version': '2',
        'passport-sdk-version': '50561',
        'x-vc-bdturing-sdk-version': '3.7.2.cn',
        'x-tt-dt': '',
        ...signHeaders,
      };
      if (bodyStr !== null) {
        headers['x-ss-stub'] = createHash('md5').update(bodyStr).digest('hex').toUpperCase();
      }

      try {
        const res = await this.throttledFetch(url!, { method: opts.method, headers, body: bodyStr ?? undefined });
        let text = await res.text();
        if (text.length === 0) {
          // 200 + 零字节 = 上游抖动，短退避重试一次（不刷新设备身份）
          await new Promise((r) => setTimeout(r, 400));
          const res2 = await this.throttledFetch(url!, { method: opts.method, headers, body: bodyStr ?? undefined });
          text = await res2.text();
          if (text.length === 0) {
            this.health.record('empty');
            throw new RiskError('上游 200 空 body（签名可能不被接受）', -1);
          }
        }
        const json = parseJsonLoose(text) as Record<string, unknown>;
        const code = Number(json['code'] ?? -1);
        if (code === 0) {
          this.health.record('ok');
          this.pool.reportOk(opts.role, host);
          return json;
        }
        if (code === 100103) throw new RiskError('PARAM_INVALID（device_id 缺失——本客户端 bug）', code);
        if (code === 110001) throw new RiskError('签名分支被拒（branch 1 泄漏）', code);
        if (code === 429 || code === 110002 || code === 110003 || res.status === 429) {
          const ra = Number(res.headers?.['retry-after'] ?? 0);
          this.pool.cool(opts.role, host, (ra > 0 ? ra : 30) * 1000);
          this.health.record('risk');
          throw new RiskError('风控/限流', code);
        }
        this.health.record('risk');
        throw new RiskError(`上游 code=${code}`, code);
      } catch (e) {
        if (e instanceof RiskError) throw e;
        // 网络层故障（含断流）：冷却换域重试
        this.pool.cool(opts.role, host, 15_000);
        this.health.record('network');
        lastNetErr = e;
      }
    }
    throw lastNetErr instanceof Error ? lastNetErr : new RiskError('上游网络故障（两域名均失败）', -3);
  }

  private async throttledFetch(url: string, init: Parameters<FetchLike>[1]): ReturnType<FetchLike> {
    await this.throttle.acquire();
    return this.fetchImpl(url, init);
  }

  // ---- 搜索（GET /reading/bookapi/search/tab/v，目录类设备） ----
  async search(query: string, offset = 0, limit = 10): Promise<{ items: AppSearchItem[]; hasMore: boolean }> {
    const dev = await this.stableDevice();
    const json = await this.appFetch({
      path: '/reading/bookapi/search/tab/v',
      method: 'GET',
      role: 'catalog',
      device: dev,
      endpointParams: [
        ['query', query],
        ['tab_name', 'feed'],
        ['search_source', '1'],
        ['offset', String(offset)],
        ['count', String(limit)],
        ['use_correct', 'true'],
      ],
    });
    const tabs = json['search_tabs'] as Array<Record<string, unknown>> | undefined;
    const data = tabs?.[0]?.['data'];
    const items: AppSearchItem[] = [];
    if (Array.isArray(data)) {
      for (const cell of data as Array<Record<string, unknown>>) {
        const item = mapSearchCell(cell);
        if (item) items.push(item);
      }
    }
    return { items, hasMore: Boolean(tabs?.[0]?.['has_more']) };
  }

  // ---- 详情（POST /novel/player/multi_video_detail/preload/v1） ----
  async detail(seriesId: string): Promise<AppDetail> {
    const dev = await this.stableDevice();
    // image_shrink_datas_str（图片裁剪策略，抓包固定值）未取到实值，先省略——
    // 服务端若拒绝再补（规格 02 §2.2 标注该字段为固定值）
    const json = await this.appFetch({
      path: '/novel/player/multi_video_detail/preload/v1',
      method: 'POST',
      role: 'catalog',
      device: dev,
      body: {
        biz_param: {
          detail_page_version: 0,
          disable_digg_stat: false,
          need_all_video_definition: false,
          need_mp4_align: false,
          screen_width_px: '900',
          source: 7,
          use_os_player: false,
          use_server_dns: false,
        },
        dr_scene: 'preload',
        series_id: seriesId,
      },
    });
    const data = json['data'] as Record<string, unknown> | undefined;
    const vd = (data?.[seriesId] ?? Object.values(data ?? {})[0]) as Record<string, unknown> | undefined;
    const videoData = (vd?.['video_data'] ?? vd) as Record<string, unknown> | undefined;
    if (!videoData || !Array.isArray(videoData['video_list'])) {
      throw new RiskError('详情空壳（风控形态：code=0 无 data）', 0);
    }
    const episodes: AppEpisode[] = (videoData['video_list'] as Array<Record<string, unknown>>).map((e, i) => ({
      vid: String(e['vid'] ?? ''),
      index: Number(e['vid_index'] ?? i + 1),
      title: pickEpisodeTitle(videoData, e),
      durationSec: Number(e['duration'] ?? 0),
    }));
    return {
      seriesId: String(videoData['series_id'] ?? seriesId),
      title: String(videoData['series_title'] ?? ''),
      intro: String(videoData['series_intro'] ?? ''),
      cover: cleanUrl(String(videoData['series_cover'] ?? '')),
      episodeCnt: Number(videoData['episode_cnt'] ?? episodes.length),
      categories: parseCategorySchema(String(videoData['category_schema'] ?? '')),
      episodes,
    };
  }

  // ---- 取流（POST /novel/player/multi_video_model/v1，b 域名 + 随机设备对 + vid 缓存） ----
  async videoModel(vid: string): Promise<Record<string, unknown>> {
    for (let round = 0; round < 3; round++) {
      const dev = AppSource.randomDevice();
      const json = await this.appFetch({
        path: '/novel/player/multi_video_model/v1',
        method: 'POST',
        role: 'stream',
        device: dev,
        body: {
          biz_param: {
            detail_page_version: 0,
            device_level: 3,
            disable_digg_stat: false,
            need_all_video_definition: true,
            need_mp4_align: false,
            use_os_player: false,
            use_server_dns: false,
            video_platform: 1024,
          },
          mixed_video_id_map: { '1004': [vid] },
        },
      });
      const data = json['data'] as Record<string, unknown> | undefined;
      if (!data || Object.keys(data).length === 0) continue; // 同设备对同 vid 一次 → 换号重试
      const entry = (data[vid] ?? Object.values(data)[0]) as Record<string, unknown> | undefined;
      let model = entry?.['video_model'];
      if (typeof model === 'string') {
        try {
          model = parseJsonLoose(model);
        } catch {
          // 保持字符串，由解析层兜底
        }
      }
      if (model && typeof model === 'object') return model as Record<string, unknown>;
    }
    throw new EmptyModelError(vid);
  }

  /** 解析全部档位流（含 fallback_api 二跳与 key_seed URL 解密）。结果按 vid 缓存。 */
  async resolveStreams(vid: string): Promise<ResolvedStream[]> {
    const cached = this.modelCache.get(vid);
    if (cached) return cached;
    const model = await this.videoModel(vid);
    const { videoList, keySeed } = await this.collectVideoList(vid, model);
    const out: ResolvedStream[] = [];
    for (const [defKey, entry] of Object.entries(videoList)) {
      const resolved = this.mapStreamEntry(vid, defKey, entry, keySeed);
      if (resolved) out.push(resolved);
    }
    // 档位从高到低
    out.sort((a, b) => qualityRank(b.definition) - qualityRank(a.definition));
    if (out.length === 0) throw new EmptyModelError(vid);
    this.modelCache.set(vid, out);
    return out;
  }

  private async collectVideoList(
    vid: string,
    model: Record<string, unknown>,
  ): Promise<{ videoList: Record<string, Record<string, unknown>>; keySeed: string | null }> {
    // 内嵌形态优先（实测 multi_video_model/v1 2026-10：模型同时带 fallback_api 与
    // video_list，内嵌已是全档位明文 URL——比二跳省一次请求）；内嵌缺失再走 fallback。
    const embedded = [model['video_list'], (model['dynamic_video'] as Record<string, unknown> | undefined)?.['dynamic_video_list'], model['dynamic_video_list']];
    for (const c of embedded) {
      const normalized = normalizeVideoList(c);
      if (normalized && Object.keys(normalized).length > 0) return { videoList: normalized, keySeed: null };
    }

    // fallback_api 二跳（免签，规格 02 §3.3）
    const fallback = extractFallbackApi(model);
    if (fallback) {
      assertAllowedUrl(fallback, 'api');
      const res = await this.throttledFetch(fallback, {
        method: 'GET',
        headers: { 'User-Agent': UA_APP_HONGGUO, Accept: 'application/json' },
        retries: 2,
      });
      const json = parseJsonLoose(await res.text()) as Record<string, unknown>;
      const info = (json['video_info'] ?? json) as Record<string, unknown>;
      const data = info['data'] as Record<string, unknown> | undefined;
      const normalized = normalizeVideoList(data?.['video_list'] ?? info['video_list']);
      if (normalized && Object.keys(normalized).length > 0) {
        return { videoList: normalized, keySeed: typeof data?.['key_seed'] === 'string' ? data['key_seed'] : null };
      }
    }
    // 其余防御性嵌套（规格 02 §3.2）
    const candidates = [(model['video_info'] as Record<string, unknown> | undefined)?.['data'], model['data']];
    for (const c of candidates) {
      const normalized = normalizeVideoList(c);
      if (normalized && Object.keys(normalized).length > 0) return { videoList: normalized, keySeed: null };
    }
    throw new EmptyModelError(vid);
  }

  private mapStreamEntry(
    vid: string,
    defKey: string,
    entry: Record<string, unknown>,
    keySeed: string | null,
  ): ResolvedStream | null {
    const mainRaw = entry['main_url'];
    if (typeof mainRaw !== 'string' || mainRaw.length === 0) return null;
    let mainUrl: string;
    try {
      mainUrl = keySeed ? decryptSpadeUrl(mainRaw, keySeed) : cleanUrl(mainRaw);
    } catch {
      return null;
    }
    assertAllowedUrl(mainUrl, 'vod');

    const backups: string[] = [];
    const backupRaw = [entry['backup_url'], entry['backup_url_1'], ...(Array.isArray(entry['backup_url_list']) ? (entry['backup_url_list'] as unknown[]) : [])];
    for (const b of backupRaw) {
      if (typeof b !== 'string' || b.length === 0) continue;
      try {
        const u = keySeed ? decryptSpadeUrl(b, keySeed) : cleanUrl(b);
        if (isAllowedUrl(u, 'vod')) backups.push(u);
      } catch {
        // 备用链解不开就跳过
      }
    }

    const meta = (entry['video_meta'] ?? entry) as Record<string, unknown>;
    const spadeRaw = entry['spade_a'] ?? (entry['encrypt_info'] as Record<string, unknown> | undefined)?.['spade_a'];
    if (typeof spadeRaw !== 'string' || spadeRaw.length === 0) return null;

    return {
      vid,
      definition: String(entry['definition'] ?? meta['definition'] ?? defKey),
      codec: String(meta['codec_type'] ?? 'unknown'),
      mainUrl,
      backupUrls: backups,
      spadeA: spadeRaw,
      size: numOrUndef(meta['size']),
      width: numOrUndef(entry['vwidth'] ?? entry['width'] ?? meta['vwidth']),
      height: numOrUndef(entry['vheight'] ?? entry['height'] ?? meta['vheight']),
    };
  }
}

// ---- 工具 ----
function qualityRank(def: string): number {
  const m = /(\d{3,4})p?/.exec(def);
  return m ? Number(m[1]) : 0;
}

/**
 * video_list 双形态归一（规格 02 §3.3 记录 map 形态；实测 multi_video_model/v1
 * 2026-10-25 为数组形态——5 档条目，档位在 video_meta.definition）。数组按
 * video_meta.definition 建键；无法取定义的用序号。
 */
function normalizeVideoList(c: unknown): Record<string, Record<string, unknown>> | null {
  if (!c || typeof c !== 'object') return null;
  if (!Array.isArray(c)) return c as Record<string, Record<string, unknown>>;
  const out: Record<string, Record<string, unknown>> = {};
  let i = 0;
  for (const e of c as Array<Record<string, unknown>>) {
    if (!e || typeof e !== 'object') continue;
    const meta = e['video_meta'] as Record<string, unknown> | undefined;
    const def = meta?.['definition'];
    const key = typeof def === 'string' && def ? def : String(i);
    out[key] = e;
    i++;
  }
  return Object.keys(out).length > 0 ? out : null;
}
function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? n : undefined;
}

function pickEpisodeTitle(videoData: Record<string, unknown>, e: Record<string, unknown>): string | null {
  // title 陷阱：多数剧每集 title 都是同一段剧情简介，与 series_intro 相同则弃用（规格 02 §2.1）
  const t = e['title'];
  if (typeof t !== 'string' || t.length === 0) return null;
  const intro = videoData['series_intro'];
  return typeof intro === 'string' && intro === t ? null : t;
}

function parseCategorySchema(schema: string): string[] {
  if (!schema) return [];
  const out: string[] = [];
  const re = /"name":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema)) !== null) out.push(m[1]!);
  return out;
}

function mapSearchCell(cell: Record<string, unknown>): AppSearchItem | null {
  const vd = cell['video_detail'] as Record<string, unknown> | undefined;
  const vdataArr = cell['video_data'];
  let vdata = Array.isArray(vdataArr) ? (vdataArr[0] as Record<string, unknown>) : (vdataArr as Record<string, unknown> | undefined);
  vdata = (vdata?.['video_detail'] as Record<string, unknown> | undefined) ?? vdata;
  const sid = cell['book_id'] ?? cell['search_result_id'] ?? vdata?.['series_id'] ?? vd?.['series_id'];
  if (sid === undefined) return null;
  const hl = (cell['search_high_light'] as Record<string, unknown> | undefined)?.['title'];
  const title =
    (hl && typeof hl === 'object' ? String((hl as Record<string, unknown>)['text'] ?? '') : '') ||
    String(vd?.['series_title'] ?? vdata?.['title'] ?? vdata?.['series_title'] ?? '');
  const episodeCnt = Number(vd?.['episode_cnt'] ?? vdata?.['episode_cnt'] ?? cell['episode_cnt'] ?? 0);
  if (episodeCnt === 0) return null; // 非短剧条目丢弃（规格 02 §2.2）
  return {
    seriesId: String(sid),
    title,
    cover: cleanUrl(String(vd?.['series_cover'] ?? vdata?.['cover'] ?? vdata?.['series_cover'] ?? '')),
    episodeCnt,
  };
}

function extractFallbackApi(model: Record<string, unknown>): string | null {
  const raw = model['fallback_api'];
  if (typeof raw === 'string' && raw.length > 0) {
    if (raw.startsWith('http')) return cleanUrl(raw);
    try {
      const nested = parseJsonLoose(raw) as Record<string, unknown>;
      const u = nested['fallback_api'] ?? (Array.isArray(nested) ? nested[0] : undefined);
      return typeof u === 'string' ? cleanUrl(u) : null;
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw) && typeof raw[0] === 'string') return cleanUrl(raw[0]!);
  if (raw && typeof raw === 'object') {
    const u = (raw as Record<string, unknown>)['fallback_api'];
    if (typeof u === 'string') return cleanUrl(u);
  }
  return null;
}

function isAllowedUrl(u: string, kind: 'api' | 'vod'): boolean {
  try {
    assertAllowedUrl(u, kind);
    return true;
  } catch {
    return false;
  }
}

/** fallback/直链域白名单（规格 02 §3.5）：https、无 userinfo、443/空端口。 */
export function assertAllowedUrl(u: string, kind: 'api' | 'vod'): void {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw new RiskError(`非 https：${u}`, -2);
  if (url.username || url.password) throw new RiskError(`含 userinfo：${u}`, -2);
  if (url.port && url.port !== '443') throw new RiskError(`非 443 端口：${u}`, -2);
  const hosts = kind === 'api' ? API_HOSTS : VOD_HOSTS;
  const ok = hosts.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
  if (!ok) throw new RiskError(`域名不在白名单：${url.hostname}`, -2);
}
