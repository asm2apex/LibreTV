import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * 标准 Range 文件下发的 Web Response 版（自 hongguo gateway/stream.ts serveFileRange
 * 移植：200/206/416 三态 + 后缀形式 bytes=-n）。node:http 响应写入换成
 * createReadStream → Readable.toWeb → Response 流式 body。
 */
export function fileRangeResponse(
  filePath: string,
  size: number,
  req: Request,
  contentType = 'video/mp4',
  filename?: string
): Response {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  });
  if (filename) headers.set('Content-Disposition', `inline; filename="${filename}"`);

  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    let start: number;
    let end: number;
    if (m[1] === '' && m[2] !== '') {
      const n = Number(m[2]);
      if (n === 0) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Number(m[2]);
    }
    if (!Number.isFinite(start) || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers });
}
