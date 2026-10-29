// 解密后 MP4 的两种输出处理。规格：docs/protocol/02-api-and-decryption.md §5.5。
// - stripAndShift（剥壳+平移）：产出干净文件，前置 = 样本已解密、moov 在 mdat 前；
//   布局不符抛 Mp4Error，调用方回落 ffmpeg remux。
// - zeroShiftPatch（零位移打补丁）：流式首选，不删盒不平移，尺寸不变。

import type { Box } from './box';
import { entryChildren } from './box';
import { patchStco, rebuildMoov } from './edit';
import type { MoovInfo } from './tables';

// sgpd/sbgp 仅当 grouping_type == 'seig'（CENC 加密组）时才删；音频常见的
// 'roll' 组与加密无关，保留——这是回环测试可做字节级对账的依据，也是对
// 规格 §5.5"删除信令盒"的收窄修正（dl 的无条件删除会误伤 roll 组）。
function seigGroupBoxes(buf: Buffer, stbl: Box): (b: Box) => boolean {
  // stbl 为 walkTable stbl 回调接口形状；判定只依赖 buf 内偏移
  void stbl;
  return (b: Box) => {
    if (b.type !== 'sgpd' && b.type !== 'sbgp') return false;
    if (b.contentStart + 8 > b.contentEnd) return false;
    const gt = buf.toString('latin1', b.contentStart + 4, b.contentStart + 8);
    return gt === 'seig';
  };
}

export function stripAndShift(buf: Buffer, info: MoovInfo): Buffer {
  const rebuilt = rebuildMoov(buf, info, {
    moov: { remove: ['pssh'] },
    stbl: (t) => ({ remove: ['senc', 'saiz', 'saio'], removeWhen: seigGroupBoxes(buf, t.stbl) }),
    entry: (t) => ({ renameTo: t.originalType, removeChildren: ['sinf'] }),
  });
  const shift = rebuilt.bytes.length - info.moov.size;
  patchStco(rebuilt.bytes, rebuilt.stco, shift, info.moov.start, info.moov.contentEnd);
  return Buffer.concat([buf.subarray(0, info.moov.start), rebuilt.bytes, buf.subarray(info.moov.contentEnd)]);
}

export function zeroShiftPatch(buf: Buffer, info: MoovInfo): void {
  for (const t of info.tracks) {
    if (t.entryType === 'encv' || t.entryType === 'enca') {
      buf.write(t.originalType, t.entry.start + 4, 'latin1');
    }
    for (const c of entryChildren(buf, t.entry)) {
      if (c.type === 'sinf') {
        buf.write('free', c.start + 4, 'latin1');
        buf.fill(0, c.contentStart, c.contentEnd);
      }
    }
  }
}
