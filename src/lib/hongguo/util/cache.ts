// 简单内存 TTL 缓存：目录/榜单/详情页数据分钟级稳定，缓存可把上游压力降一个
// 量级（官网对突发有软限流，实测簇状失败）。容量上限防膨胀，过期即删。

export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 128) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | null {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // LRU 触碰：重插到尾部
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
