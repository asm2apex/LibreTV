'use client';

/**
 * 全站统一页脚：只有站名。
 * 不放仓库链接、版本号、更新检测：这些都是网络空间探测引擎（FOFA 一类）用来归类站点的特征，
 * 也不向第三方（GitHub API）暴露本站存在。
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line py-4">
      <p className="text-center text-xs text-faint">FreeTV</p>
    </footer>
  );
}
