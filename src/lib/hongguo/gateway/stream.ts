// 流管线：解析直链 → 下载密文 → spade 派生 key → verify → 逐样本解密 → 剥壳落盘
// → Range 下发。规格：docs/protocol/02-api-and-decryption.md §7.2（形态 B）。
// 同集并发去重（in-flight Promise map）+ 成品缓存（mtime LRU）。

import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ResolvedStream } from '../api/appsource';
import { deriveContentKey } from '../crypto/spade';
import { decryptTrack, verifyKey } from '../mp4/cenc';
import { stripAndShift, zeroShiftPatch } from '../mp4/patch';
import { parseMoov } from '../mp4/tables';
import { fetchWithRetry } from '../util/http';

export interface StreamPipelineDeps {
  cacheDir: string;
  maxCacheFiles?: number; // 成品缓存数量上限（规格 02 §7.2）
  maxCacheBytes?: number; // 字节上限（默认 1GiB），与数量上限同时生效
}

/** 媒体下载头集（规格 02 §9.3：App 短 UA + Referer 白名单三选一，取 tvbox 在用值）。 */
const MEDIA_HEADERS = {
  'User-Agent': 'com.phoenix.read/71332',
  Referer: 'https://novel.snssdk.com/',
} as const;

export class StreamPipeline {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly deps: StreamPipelineDeps;

  constructor(deps: StreamPipelineDeps) {
    this.deps = deps;
  }

  private cachePath(vid: string, quality: string): string {
    const safe = `${vid}_${quality}`.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.deps.cacheDir, `${safe}.mp4`);
  }

  /** 缓存路径（网关直读用）。 */
  cachePathOf(vid: string, quality: string): string {
    return this.cachePath(vid, quality);
  }

  /**
   * 确保解密成品存在（缓存/并发去重/下载/解密/剥壳），返回成品文件路径。
   * resolve 由调用方注入（网关里 = appSource.resolveStreams + 选档）。
   */
  async ensureDecrypted(vid: string, quality: string, resolve: () => Promise<ResolvedStream>): Promise<string> {
    const file = this.cachePath(vid, quality);
    if (existsSync(file)) return file;

    const running = this.inflight.get(file);
    if (running) return running;

    const job = (async () => {
      const stream = await resolve();
      const cipher = await this.downloadCipher(stream);
      const plain = decryptAndStrip(cipher, stream.spadeA);
      await mkdir(this.deps.cacheDir, { recursive: true });
      await writeFile(file, plain);
      await this.evict();
      return file;
    })().finally(() => {
      this.inflight.delete(file);
    });

    this.inflight.set(file, job);
    return job;
  }

  /** 下载密文（backup_url 逐个回落；短包=重试交给 fetchWithRetry 的重试计数）。 */
  private async downloadCipher(stream: ResolvedStream): Promise<Buffer> {
    const urls = [stream.mainUrl, ...stream.backupUrls];
    let lastErr: unknown = null;
    for (const u of urls) {
      try {
        const res = await fetchWithRetry(u, { headers: { ...MEDIA_HEADERS }, retries: 2, timeoutMs: 30000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error('空 body');
        // 206 语义下 content-length 只对应当前分片，完整校验交给解密层
        return buf;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('密文下载失败');
  }

  private async evict(): Promise<void> {
    const maxFiles = this.deps.maxCacheFiles ?? 30;
    const maxBytes = this.deps.maxCacheBytes ?? 2 ** 30;
    const files = await readdir(this.deps.cacheDir).catch(() => [] as string[]);
    const statted: Array<{ name: string; mtime: number; size: number }> = [];
    for (const f of files) {
      const s: Stats | undefined = await stat(path.join(this.deps.cacheDir, f)).catch(() => undefined);
      if (s?.isFile()) statted.push({ name: f, mtime: s.mtimeMs, size: s.size });
    }
    let total = statted.reduce((acc, f) => acc + f.size, 0);
    if (statted.length <= maxFiles && total <= maxBytes) return;
    statted.sort((a, b) => a.mtime - b.mtime); // 最旧优先删
    while (statted.length > 0 && (statted.length > maxFiles || total > maxBytes)) {
      const victim = statted.shift()!;
      await unlink(path.join(this.deps.cacheDir, victim.name)).catch(() => {});
      total -= victim.size;
    }
  }

  /** 缓存规模（/health 暴露用）。 */
  async stats(): Promise<{ files: number; bytes: number }> {
    const files = await readdir(this.deps.cacheDir).catch(() => [] as string[]);
    let bytes = 0;
    let n = 0;
    for (const f of files) {
      const s: Stats | undefined = await stat(path.join(this.deps.cacheDir, f)).catch(() => undefined);
      if (s?.isFile()) {
        bytes += s.size;
        n++;
      }
    }
    return { files: n, bytes };
  }

  /** 读取成品（缓存命中时网关直接走 serveFileRange，此方法主要供测试与下载导出）。 */
  async readDecrypted(vid: string, quality: string): Promise<Buffer | null> {
    const p = this.cachePath(vid, quality);
    return existsSync(p) ? readFile(p) : null;
  }

  /**
   * 降级兜底：签名通道不可用时反向代理官网 360P 公开直链（免签免解密，Range 透传）。
   * 返回 false = 该集无公开版（付费/锁定集）。
   */
  async servePublic360(
    vid: string,
    req: IncomingMessage,
    res: ServerResponse,
    probe: () => Promise<{ ok: boolean; url: string; size?: number }>,
  ): Promise<boolean> {
    const p = await probe();
    if (!p.ok) return false;
    const range = req.headers['range'];
    const upstream = await fetch(p.url, {
      headers: {
        'User-Agent': 'com.phoenix.read/71332',
        Referer: 'https://hongguoduanju.com/',
        ...(typeof range === 'string' ? { Range: range } : {}),
      },
      redirect: 'follow',
    });
    if (!upstream.ok && upstream.status !== 206) return false;
    const h: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    for (const k of ['content-length', 'content-range']) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(upstream.status, h);
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return true;
  }
}

/** 密文 → 解密 → 剥壳（verify-before-decrypt，规格 02 §5.4）。 */
export function decryptAndStrip(cipher: Buffer, spadeA: string): Buffer {
  const key = Buffer.from(deriveContentKey(spadeA), 'hex');
  const buf = Buffer.from(cipher); // 原地解密，勿动调用方缓冲
  const info = parseMoov(buf);
  const vide = info.tracks.find((t) => t.handler === 'vide');
  if (!vide) throw new Error('无视频轨');
  if (!verifyKey(buf, vide, key)) {
    throw new Error('key 自证失败（spade_a 与密文不对应，或 ver2）');
  }
  for (const t of info.tracks) decryptTrack(buf, t, key);
  try {
    return stripAndShift(buf, info);
  } catch {
    // 布局不符（moov 后置/双 moov/64 位盒等）回落零位移打补丁（规格 02 §5.5）
    zeroShiftPatch(buf, info);
    return buf;
  }
}

/**
 * 标准 Range 文件下发：200/206/416 三态 + HEAD（规格 02 §7.2 streamFile 语义）。
 */
export function serveFileRange(
  filePath: string,
  size: number,
  req: IncomingMessage,
  res: ServerResponse,
  contentType = 'video/mp4',
  filename?: string,
): void {
  const range = req.headers['range'];
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  if (filename) {
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': String(size) });
    res.end();
    return;
  }
  if (typeof range === 'string') {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    let start: number;
    let end: number;
    if (m[1] === '' && m[2] !== '') {
      // 后缀形式 bytes=-n：取末 n 字节
      const n = Number(m[2]);
      if (n === 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Number(m[2]);
    }
    if (!Number.isFinite(start) || start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Length': String(size) });
  createReadStream(filePath).pipe(res);
}

/** 网关内部用的 etag（缓存键校验用，非必需）。 */
export function quickHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
