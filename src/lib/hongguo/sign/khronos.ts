// X-Khronos 与 argus/ladon 存根（规格 §3.2）。
// x-khronos = str(khronos)；存根模式（仅红果端点，当前被服务端接受）：
//   x-ladon = base64(BE32(khronos))；x-argus = base64(LE32(khronos))
// 【推断→强】两个独立部署实现以此通过真实端点，但服务端随时可能开始校验实算值（§8.1）。
import { be32, le32, assertU32 } from './util';

export function khronosHeader(khronos: number): string {
  return String(assertU32(khronos, 'khronos'));
}

export function ladonStub(khronos: number): string {
  return be32(assertU32(khronos, 'khronos')).toString('base64');
}

export function argusStub(khronos: number): string {
  return le32(assertU32(khronos, 'khronos')).toString('base64');
}
