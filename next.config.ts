import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig: NextConfig = {
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  // 不下发 X-Powered-By：少一个被网络空间探测引擎归类的响应头特征
  poweredByHeader: false,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
  // HTML 文档必须每次再验证：Next 默认对静态页下发 s-maxage=31536000（CDN 缓存一年），
  // 自托管且无法主动清 CDN 缓存的部署里，版本更新会让用户长期停在旧壳（真实踩过）。
  // 带 hash 的静态资产仍走 immutable 缓存，不受影响。
  async headers() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'document' }],
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
