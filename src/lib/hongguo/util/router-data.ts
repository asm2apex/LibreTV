// 官网页面 SSR 数据提取：window._ROUTER_DATA 的括号平衡扫描 + 大整数安全 JSON 解析。
// 规格：docs/protocol/02-api-and-decryption.md §1.1（提取方式：定位 _ROUTER_DATA
// 后做括号平衡扫描）。平衡扫描必须跟踪字符串态——JSON 字符串里可能出现
// 不配对的花括号（剧名/简介文本）。

/**
 * 提取并解析 _ROUTER_DATA。找不到或解析失败返回 null。
 * 17 位以上裸整数（超 Number.MAX_SAFE_INTEGER 的 series_id/vid）先转字符串
 * 再 JSON.parse，防止精度丢失——实测 suggestion/detail 的 series_id 均为
 * 19 位数字，直接 JSON.parse 会静默四舍五入成错误 ID。
 */
export function extractRouterData(html: string): unknown | null {
  const marker = '_ROUTER_DATA';
  let idx = html.indexOf(marker);
  while (idx >= 0) {
    const brace = html.indexOf('{', idx + marker.length);
    if (brace < 0) return null;
    const end = matchBrace(html, brace);
    if (end > 0) {
      try {
        return parseJsonLoose(html.slice(brace, end + 1));
      } catch {
        // 落到下一个 marker 再试（页面里可能出现注释掉的副本）
      }
    }
    idx = html.indexOf(marker, idx + 1);
  }
  return null;
}

/** 从 start（'{' 位置）做括号平衡，返回配对 '}' 的下标；失败 -1。 */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 大整数安全 JSON 解析：17+ 位裸整数转字符串。 */
export function parseJsonLoose(raw: string): unknown {
  const fixed = raw.replace(/(:\s*)(-?\d{17,})(\s*[},\]])/g, '$1"$2"$3');
  return JSON.parse(fixed);
}
