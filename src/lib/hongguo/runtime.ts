import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppSource } from './api/appsource';
import { WebSource } from './api/websource';
import { StreamPipeline } from './gateway/stream';
import { branchOf, signRequest } from './sign';

/**
 * 红果网关装配（自 hongguo 研究项目 server/src 移植，模块逐文件原样拷贝）。
 * 原 gateway/server.ts 的 node:http 壳由 Next API 路由替代。
 * 设备档案与解密流缓存默认落在系统 tmpdir（容器重启即重建：device_id 重生成、
 * 缓存失效但不影响正确性）；可用 HONGGUO_DATA_DIR / HONGGUO_CACHE_DIR 指到持久卷。
 */

const DATA_DIR = process.env.HONGGUO_DATA_DIR || join(tmpdir(), 'freetv-hongguo', 'data');
const CACHE_DIR = process.env.HONGGUO_CACHE_DIR || join(tmpdir(), 'freetv-hongguo', 'stream-cache');

export interface HongguoRuntime {
  app: AppSource;
  web: WebSource;
  pipeline: StreamPipeline;
}

let instance: HongguoRuntime | null = null;

export function hongguoRuntime(): HongguoRuntime {
  if (instance) return instance;
  mkdirSync(DATA_DIR, { recursive: true });
  const app = new AppSource({ sign: signRequest, branchOf, dataDir: DATA_DIR });
  const web = new WebSource();
  const pipeline = new StreamPipeline({ cacheDir: CACHE_DIR });
  instance = { app, web, pipeline };
  return instance;
}
