// 签名模块对外接口：signRequest（八头组装）+ branchOf（hashF13 分支预检）。
// 唯一实现依据 docs/protocol/01-signing.md。头名全部小写（HTTP 头大小写不敏感，规格 §2.2）。
//
// 语境行为（规格 §1/§2.1）：
// - hongguo（默认）：六头全签。x-helios/x-medusa 恒实算；x-ladon/x-argus 默认实算
//   （x-ladon 复用 helios 三元组——规格 §3.4 同一算法，红果语境 ladon 常量未在规格单独定义，
//   [T]/[P] 均以存根部署；argus 实算用番茄常量——规格 §3.5 仅给该组，服务端当前弱校验 §8.1）；
//   stubLadonArgus=true 时二者退化为 §3.2 存根（红果端点当前接受）。
// - fanqie：四头（x-khronos/x-gorgon/x-ladon/x-argus，[D:491-496]），ladon/argus 恒实算（番茄端点必须，§1）。
// 附加头：x-ss-stub（有 body 时 = md5 hex 大写，§3.7）、x-ss-req-ticket（query _rticket，缺省 khronos*1000，§6.1）。
import { randomBytes, randomInt } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { md5Raw, utf8, assertU32 } from './util';
import { buildGorgonSeed, transformGorgonSeed, queryStringOf } from './gorgon';
import { SDK_NUM_HONGGUO, SDK_NUM_FANQIE, GORGON_PARAM_HONGGUO } from './constants';
import { ladon as ladonSign, helios as heliosSign } from './helios';
import { argus } from './argus';
import { khronosHeader, ladonStub, argusStub } from './khronos';
import { medusa, branchInfoOf, MedusaBranch1Error } from './medusa';
import { sm3 } from './sm3';

export type SignContext = 'hongguo' | 'fanqie';

export interface SignRandom {
  hb2: number; // gorgon 头字节（红果语境全域随机，规格 §6.3）
  hb3: number;
  heliosRand: number; // u32（helios prefix/轮密钥种子；红果实算 x-ladon 复用）
  ladonRand: Uint8Array; // 4B（番茄语境 ladon prefix）
  argusRandom: number;
  argusSignCount: number; // 偶数 2..98（§6.3）
  medusaProtoRand: number;
  medusaRndKey: number;
  medusaRndXm: number;
  medusaLaunchTime: number; // 100..120（§6.3）
  medusaPid: number; // 10001..12000（§6.3）
  secDeviceToken: string;
}

export interface SignInput {
  /** 完整 URL；query 串参与签名（问号后原始串，字节级敏感，规格 §2.2） */
  url: string;
  /** POST body 原文（null/undefined = GET） */
  body?: string | null;
  cookie?: string | null;
  /** medusa proto f5 / device f4 */
  deviceId: string;
  /** gorgon parameter；缺省按语境（红果 320 / 番茄 0，规格 §9.2） */
  parameter?: number;
}

export interface SignOptions {
  /** 常量组随语境（规格 §1），默认 hongguo */
  context?: SignContext;
  /** 签名时刻 unix 秒，默认 now */
  khronos?: number;
  /** 注入随机场（测试复现）；缺省自动随机（§6.3） */
  random?: Partial<SignRandom>;
  /** true 时 ladon/argus 用存根（规格 §3.2，红果端点当前接受；默认 false） */
  stubLadonArgus?: boolean;
}

// 进程级 sec_device_token（[P] 路线：base64url(18 随机字节)，规格 §5/§9.6）
const PROCESS_SEC_TOKEN = randomBytes(18).toString('base64url');

function makeRandom(context: SignContext, inject?: Partial<SignRandom>): SignRandom {
  // hb2/hb3 随机域按语境（规格 §6.3）：红果全域（[T]/[P]）；番茄 [D] 约束域
  const autoHb =
    context === 'fanqie'
      ? { hb2: (((randomInt(0, 256) % 7) + 1) << 5) & 0xff, hb3: 0xe0 | randomInt(0, 16) }
      : { hb2: randomInt(0, 256), hb3: randomInt(0, 256) };
  return {
    hb2: inject?.hb2 ?? autoHb.hb2,
    hb3: inject?.hb3 ?? autoHb.hb3,
    heliosRand: inject?.heliosRand ?? randomInt(0, 2 ** 32),
    ladonRand: inject?.ladonRand ?? randomBytes(4),
    argusRandom: inject?.argusRandom ?? randomInt(0, 2 ** 32),
    argusSignCount: inject?.argusSignCount ?? 2 + 2 * randomInt(0, 49),
    medusaProtoRand: inject?.medusaProtoRand ?? randomInt(0, 2 ** 32),
    medusaRndKey: inject?.medusaRndKey ?? randomInt(0, 2 ** 32),
    medusaRndXm: inject?.medusaRndXm ?? randomInt(0, 2 ** 32),
    medusaLaunchTime: inject?.medusaLaunchTime ?? 100 + randomInt(0, 21),
    medusaPid: inject?.medusaPid ?? 10001 + randomInt(0, 2000),
    secDeviceToken: inject?.secDeviceToken ?? PROCESS_SEC_TOKEN,
  };
}

function rticketFromQuery(query: string, khronos: number): string {
  const m = /(?:^|&)_rticket=(\d+)(?:&|$)/.exec(query);
  return m ? m[1]! : String(khronos * 1000);
}

function aidFromQuery(query: string): number {
  const m = /(?:^|&)aid=(\d+)(?:&|$)/.exec(query);
  if (!m) throw new TypeError('fanqie 语境 x-ladon 需要 query 中的数值 aid（[DT:90-110] 语义）');
  return Number(m[1]!);
}

/** 完整签名：返回全部小写头名 → 值。branch 1 输入抛 MedusaBranch1Error（调用方抖 _rticket，规格 §6.2） */
export function signRequest(input: SignInput, opts: SignOptions = {}): Record<string, string> {
  const context: SignContext = opts.context ?? 'hongguo';
  const khronos = assertU32(opts.khronos ?? Math.floor(Date.now() / 1000), 'khronos');
  if (typeof input.url !== 'string') throw new TypeError('url 必须是字符串');
  if (typeof input.deviceId !== 'string' || input.deviceId === '') {
    throw new TypeError('deviceId 必须是非空字符串（medusa proto f5 / device f4）');
  }
  const rnd = makeRandom(context, opts.random);
  const query = queryStringOf(input.url);
  const parameter = input.parameter ?? (context === 'hongguo' ? GORGON_PARAM_HONGGUO : 0);
  const sdkNum = context === 'hongguo' ? SDK_NUM_HONGGUO : SDK_NUM_FANQIE;
  const body = input.body ?? null;

  const headers: Record<string, string> = {};
  headers['x-khronos'] = khronosHeader(khronos);

  // gorgon：stub 优先（== md5(body)），否则 body，否则 4×0（§3.3.1）
  headers['x-gorgon'] = Buffer.from(
    transformGorgonSeed(
      buildGorgonSeed({ query, khronos, body, cookie: input.cookie ?? null, sdkNum }),
      rnd.hb2,
      rnd.hb3,
      parameter,
    ),
  ).toString('hex');

  if (opts.stubLadonArgus === true) {
    headers['x-ladon'] = ladonStub(khronos);
    headers['x-argus'] = argusStub(khronos);
  } else {
    if (context === 'fanqie') {
      headers['x-ladon'] = ladonSign(khronos, aidFromQuery(query), rnd.ladonRand);
    } else {
      // 红果实算 x-ladon = helios 同算法同三元组，prefix 同源 LE32(heliosRand)（见文件头注释）
      headers['x-ladon'] = heliosSign(khronos, rnd.heliosRand);
    }
    headers['x-argus'] = argus({
      query,
      khronos,
      body,
      random: rnd.argusRandom,
      signCount: rnd.argusSignCount,
    });
  }

  if (context === 'hongguo') {
    headers['x-helios'] = heliosSign(khronos, rnd.heliosRand);
    headers['x-medusa'] = medusa({
      query,
      body,
      deviceId: input.deviceId,
      khronos,
      secDeviceToken: rnd.secDeviceToken,
      protoRand: rnd.medusaProtoRand,
      rndKey: rnd.medusaRndKey,
      rndXm: rnd.medusaRndXm,
      launchTime: rnd.medusaLaunchTime,
      pid: rnd.medusaPid,
    });
  }

  if (body != null && body !== '') {
    headers['x-ss-stub'] = md5Raw(utf8(body)).toString('hex').toUpperCase(); // §3.7：大写
  }
  headers['x-ss-req-ticket'] = rticketFromQuery(query, khronos); // §6.1：== query _rticket
  return headers;
}

/** hashF13 分支预检（客户端 _rticket 抖动用：branch==1 时 _rticket+1 重签，规格 §6.2） */
export function branchOf(url: string, body: string | null, khronos: number): 0 | 1 | 2 {
  const k = assertU32(khronos, 'khronos');
  const query = queryStringOf(url);
  const querySm3 = sm3(utf8(query));
  const bodyMd5 = body != null && body !== '' ? md5Raw(utf8(body)) : Buffer.alloc(16);
  return branchInfoOf(querySm3, bodyMd5, k).branch;
}

export { MedusaBranch1Error };
