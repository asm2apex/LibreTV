// fqnovel API 域名池：6 域名同构（规格 02 §1.2），角色粘滞 + 故障冷却轮换。
// 角色粘滞：目录/取流各自记住上次成功的域名，失败才换——减少无谓跳域。
// 冷却来源：429/风控码（按 Retry-After 或默认 30s）、网络错误（15s）。

export const FQNOVEL_HOSTS = [
  'https://api5-normal-sinfonlinea.fqnovel.com',
  'https://api5-normal-sinfonlineb.fqnovel.com',
  'https://api5-normal-sinfonlinec.fqnovel.com',
  'https://api5-normal-lf.fqnovel.com',
  'https://api5-normal-lq.fqnovel.com',
  'https://api5-normal-hl.fqnovel.com',
] as const;

export class DomainPool {
  private readonly cooldown = new Map<string, number>(); // host → 解禁时刻 ms
  private readonly sticky = new Map<string, string>(); // role → host
  private readonly hosts: readonly string[];

  constructor(hosts: readonly string[] = FQNOVEL_HOSTS) {
    this.hosts = hosts;
  }

  /** 取该角色当前域名：粘滞域名可用则续用，否则任一未冷却域名，全冷却则退回首域自然试探。 */
  pick(role: string): string {
    const now = Date.now();
    const stickyHost = this.sticky.get(role);
    if (stickyHost && (this.cooldown.get(stickyHost) ?? 0) <= now) return stickyHost;
    const alive = this.hosts.find((h) => (this.cooldown.get(h) ?? 0) <= now);
    const chosen = alive ?? this.hosts[0]!;
    this.sticky.set(role, chosen);
    return chosen;
  }

  /** 标记成功（粘滞在该域名）。 */
  reportOk(role: string, host: string): void {
    this.sticky.set(role, host);
  }

  /** 冷却域名（风控 30s 起/按 Retry-After，网络错误 15s），并解除该角色的粘滞。 */
  cool(role: string, host: string, ms: number): void {
    this.cooldown.set(host, Math.max(this.cooldown.get(host) ?? 0, Date.now() + ms));
    if (this.sticky.get(role) === host) this.sticky.delete(role);
  }

  activeCount(): number {
    const now = Date.now();
    return this.hosts.filter((h) => (this.cooldown.get(h) ?? 0) <= now).length;
  }

  get size(): number {
    return this.hosts.length;
  }
}
