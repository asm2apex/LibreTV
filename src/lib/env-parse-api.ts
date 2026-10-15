/**
 * 部署者通过 PARSE_API 环境变量配置的官源解析接口模板。
 *
 * 形如 `https://api.example.com/api/?key=xxx&url={url}`；不含 `{url}` 时把编码后的
 * 页面地址直接拼在末尾（与 customImageProxy 的模板语义一致，厂商文档也多写成 `&url=` 结尾）。
 * 密钥随模板只存在于服务端，不下发给浏览器——解析按次计费，key 外泄等于额度外泄。
 * 未配置返回 undefined；取值非 http(s) 时告警并忽略，不影响站点运行。
 */
export function getParseApiTemplate(): string | undefined {
  const raw = process.env.PARSE_API?.trim();
  if (!raw) return undefined;
  if (!/^https?:\/\//i.test(raw)) {
    console.warn('[LibreTV] PARSE_API 取值无效，已忽略（需为 http(s) 地址模板）');
    return undefined;
  }
  return raw;
}

/** 把页面地址填入模板：占位符替换或尾部拼接，均做 URL 编码 */
export function buildParseApiUrl(template: string, pageUrl: string): string {
  const encoded = encodeURIComponent(pageUrl);
  return template.includes('{url}') ? template.replace('{url}', encoded) : template + encoded;
}
