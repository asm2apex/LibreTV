import Dexie from 'dexie';
import { db } from './db';

/**
 * 项目改名（LibreTV → FreeTV）后的浏览器端存储迁移。
 * 存储键、Cache Storage 桶名、IndexedDB 库名都改了前缀，老用户的设置 / 历史 / 进度不能凭空消失：
 * - 同步部分（localStorage）在 Providers 首次渲染时执行，早于子组件读主题 / 设置的 effect；
 * - 异步部分（Cache Storage、IndexedDB）在 persist rehydrate 之前 await。
 * 旧键搬完即删，之后每次启动都是空操作。
 */

const LOCAL_KEYS: [string, string][] = [
  ['libretv-settings', 'freetv-settings'],
  ['libretv-theme', 'freetv-theme'],
  ['libretv-video-cache-settings', 'freetv-video-cache-settings'],
  ['libretv-settings-tab', 'freetv-settings-tab'],
];
/** 分片缓存只是加速用，旧桶直接删；未完成下载的分片也在旧桶里，会从头再下 */
const LEGACY_CACHE_BUCKETS = ['libretv-video-v1', 'libretv-dl-v1'];
const LEGACY_DB = 'libretv';

export function migrateLegacyLocalStorage(): void {
  if (typeof localStorage === 'undefined') return;
  for (const [oldKey, newKey] of LOCAL_KEYS) {
    try {
      const value = localStorage.getItem(oldKey);
      if (value === null) continue;
      if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    } catch {
      // 隐私模式 / 配额：放弃迁移，不影响启动
    }
  }
}

export async function migrateLegacyBrowserStores(): Promise<void> {
  if (typeof caches !== 'undefined') {
    for (const name of LEGACY_CACHE_BUCKETS) {
      try { await caches.delete(name); } catch { /* 忽略 */ }
    }
  }
  if (typeof indexedDB === 'undefined') return;
  try {
    if (!(await Dexie.exists(LEGACY_DB))) return;
    // 不声明 schema 即按库里现有结构打开（Dexie 动态模式），逐表搬到新库；
    // segmentMeta / downloads 指向的分片在已删除的旧桶里，不搬
    const legacy = new Dexie(LEGACY_DB);
    await legacy.open();
    const copy = async <T,>(table: string, target: { bulkPut(items: T[]): Promise<unknown> }) => {
      if (!legacy.tables.some((t) => t.name === table)) return;
      const rows = (await legacy.table(table).toArray()) as T[];
      if (rows.length > 0) await target.bulkPut(rows);
    };
    await copy('history', db.history);
    await copy('progress', db.progress);
    await copy('searchHistory', db.searchHistory);
    await copy('liveProbe', db.liveProbe);
    legacy.close();
    await Dexie.delete(LEGACY_DB);
  } catch {
    // 迁移失败不阻塞启动：旧库原样留着，下次启动再试
  }
}
