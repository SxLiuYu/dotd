/**
 * src/exec/disk.ts —— DiskGardener（execution.md §8 磁盘占用上限与回收）。
 *
 * 预算默认值（全部进 SQLite `exec_disk_policy`，可被 Web UI 配置覆盖）：
 *   镜像 2 tag / home 2GB / profile 2GB / state(ledger) 64MB / tmpfs 256MB /
 *   可写层≈0 / 容器日志 20MB / 系统级 df free < 5GB 触发回收（S6：<2GB → critical）。
 *
 * 回收顺序（§8）：prune dangling 镜像 → `docker builder prune -f` → prune 无主卷
 * （**排除**在册 home/profile/state 卷，白名单来自 exec_volumes 表）→ 清 profile 缓存；
 * 每步发事件。全程串行、可被 busy 容器让路（只动非 busy 对象）。
 *
 * 运行节律：每 6h cron + 每次镜像构建后各跑一次（由 CP registerInternalJob 挂载，
 * 契约 J4：cron 宿主唯一）。本文件只提供 `runOnce()`，不自己起定时器（避免常驻句柄）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type { ContainerBackend, ExecConfig, ExecVolumeRow } from './types.ts';

export interface DiskGardenerDeps {
  db: DatabaseSync;
  bus: EventBus;
  cfg: ExecConfig;
  backend: ContainerBackend;
  /** 该 dot 是否有 in-flight 调用（§8：可被 busy 容器让路）。 */
  hasInflight(dotId: string): boolean;
  /** 容器内清理 profile 缓存（§8：unlink，context 关闭时才清）——由 ExecService 注入。 */
  cleanProfileCaches?(dotId: string): Promise<number>;
}

export interface GardenerReport {
  freedMb: number;
  steps: string[];
  /** 触发的告警事件（§8：home/profile 超限告警；S6：critical）。 */
  alerts: Array<{ volume: string; usedMb: number; quotaMb: number; critical: boolean }>;
  skippedBusy: string[];
}

export class DiskGardener {
  constructor(private readonly deps: DiskGardenerDeps) {}

  /** 读一个策略值（缺省回 config 默认）。 */
  policy(key: keyof ExecConfig['diskPolicyDefaults']): number {
    const row = this.deps.db
      .prepare('SELECT value_mb FROM exec_disk_policy WHERE key = ?')
      .get(key) as { value_mb?: number } | undefined;
    return row?.value_mb ?? this.deps.cfg.diskPolicyDefaults[key] ?? 0;
  }

  /** 写策略（Web UI 配置覆盖入口，S4：数据源 = exec_disk_policy）。 */
  setPolicy(key: string, valueMb: number): void {
    this.deps.db
      .prepare(
        `INSERT INTO exec_disk_policy (key, value_mb, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_mb = excluded.value_mb, updated_at = excluded.updated_at`,
      )
      .run(key, valueMb, new Date().toISOString());
  }

  /** 在册卷集合（DiskGardener 白名单依据，防误删，§8/§9）。 */
  registeredVolumes(): ExecVolumeRow[] {
    return this.deps.db.prepare('SELECT * FROM exec_volumes ORDER BY name').all() as unknown as ExecVolumeRow[];
  }

  /**
   * 采集在册卷用量（宿主侧 du 近似：stub 后端返回预置值）。
   * 真实路径由容器内 du 经 /fs/ops 或 stats 采集；此处只做"最近一次 du"落库。
   */
  async refreshVolumeUsage(): Promise<void> {
    for (const v of this.registeredVolumes()) {
      const usage = await this.deps.backend.volumeUsageMb(v.name);
      if (usage === null) continue;
      this.deps.db.prepare('UPDATE exec_volumes SET usage_mb = ? WHERE name = ?').run(usage, v.name);
      await this.checkQuota(v.name, v.quota_mb, usage);
    }
  }

  /** 超限告警（§8：home/profile 超限**不自动删**，只发 exec.disk.pressure）。 */
  private async checkQuota(name: string, quotaMb: number, usageMb: number): Promise<void> {
    if (usageMb < quotaMb) return;
    this.deps.bus.publish('exec.disk.pressure', {
      volume: name,
      usedMb: usageMb,
      quotaMb,
      critical: false,
      at: new Date().toISOString(),
    });
  }

  /**
   * §8 步骤②后半：prune 无主卷。
   *
   * 「无主」的判定（白名单 = exec_volumes 在册卷名）：
   *  宿主 `docker volume ls` 里存在，但 exec_volumes 没有登记的名字 —— 即遗留的历史卷。
   * 在册卷（home/profile/state）一律不动：它们的保留/删除由 destroyDotContainer 的
   * keepVolumes 语义决定（§4.3：卷保留是默认行为），DiskGardener 不越权。
   * busy dot 的卷也不动（§8「可被 busy 容器让路」）。
   */
  private async pruneUnregisteredVolumes(
    report: GardenerReport,
    busyDots: Set<string>,
  ): Promise<void> {
    let hostNames: string[];
    try {
      hostNames = await this.deps.backend.listVolumeNames();
    } catch {
      return; // 枚举失败（如 docker 不可用）：跳过本步，不影响后续
    }
    if (hostNames.length === 0) return;

    const registered = this.registeredVolumes();
    const registeredNames = new Set(registered.map((v) => v.name));
    // 在册卷按 dot 归属，供 busy 让路判定（无主卷没有 dot 归属，不需要判定）
    const busyVolumes = new Set(
      registered.filter((v) => busyDots.has(v.dot_id)).map((v) => v.name),
    );

    for (const name of hostNames) {
      if (registeredNames.has(name)) continue; // 在册：白名单保护
      if (busyVolumes.has(name)) continue; // busy：让路
      const usage = await this.deps.backend.volumeUsageMb(name);
      try {
        await this.deps.backend.removeVolume(name);
        report.freedMb += usage ?? 0;
        report.steps.push(`volume_prune_unregistered:${name}:${usage ?? 0}`);
      } catch {
        // 卷正在被使用/已消失：正常跳过
      }
    }
  }

  /**
   * runOnce()：§8 顺序执行。返回回收报告。
   *  - df free < 5GB 才动系统级回收；否则只做卷用量刷新与配额告警。
   */
  async runOnce(): Promise<GardenerReport> {
    const report: GardenerReport = { freedMb: 0, steps: [], alerts: [], skippedBusy: [] };
    const busyDots = new Set(
      (this.deps.db.prepare("SELECT DISTINCT dot_id AS d FROM exec_calls WHERE state IN ('sent','running')").all() as Array<{ d: string }>).map(
        (r) => r.d,
      ),
    );
    for (const d of busyDots) report.skippedBusy.push(d);

    await this.refreshVolumeUsage();

    const freeMb = await this.deps.backend.diskFreeMb();
    const floor = this.policy('disk_free_min_mb');
    const criticalFloor = this.policy('disk_critical_free_mb');

    if (freeMb >= criticalFloor && freeMb >= floor) return report;

    // ① prune dangling 镜像
    try {
      await this.deps.backend.removeImage('__dangling__');
      report.steps.push('image_prune_dangling');
    } catch {
      // 没有 dangling 镜像：正常
    }

    // ② prune 构建缓存 + 无主卷（execution.md:404：`docker builder prune -f` → prune 无主卷，
    //    **排除**在册 home/profile/state 卷，白名单来自 exec_volumes 表）
    //    先回收构建缓存（对运行中容器零影响，最安全的回收量）
    try {
      const pruned = await this.deps.backend.builderPrune();
      report.freedMb += pruned.freedMb;
      report.steps.push(`builder_prune:${pruned.freedMb}`);
    } catch {
      // builder prune 不可用（如 stub）：正常跳过
    }
    await this.pruneUnregisteredVolumes(report, busyDots);

    // ③ 清 profile 缓存（水位 80% 时；context 关闭时才清）
    if (this.deps.cleanProfileCaches !== undefined) {
      for (const v of this.registeredVolumes()) {
        if (v.kind !== 'profiles' || v.usage_mb === null) continue;
        if (v.usage_mb < v.quota_mb * 0.8) continue;
        if (this.deps.hasInflight(v.dot_id)) {
          if (!report.skippedBusy.includes(v.dot_id)) report.skippedBusy.push(v.dot_id);
          continue;
        }
        const freed = await this.deps.cleanProfileCaches(v.dot_id);
        if (freed > 0) {
          report.freedMb += freed;
          report.steps.push(`profile_cache_clean:${v.dot_id}:${freed}`);
        }
      }
    }

    if (freeMb < criticalFloor) {
      for (const v of this.registeredVolumes()) {
        if (v.usage_mb !== null && v.usage_mb >= v.quota_mb) {
          report.alerts.push({ volume: v.name, usedMb: v.usage_mb, quotaMb: v.quota_mb, critical: true });
          this.deps.bus.publish('exec.disk.pressure', {
            volume: v.name,
            usedMb: v.usage_mb,
            quotaMb: v.quota_mb,
            critical: true,
            at: new Date().toISOString(),
          });
        }
      }
    }

    if (report.steps.length > 0 || report.alerts.length > 0) {
      this.deps.bus.publish('exec.disk.gardened', {
        freedMb: report.freedMb,
        steps: report.steps,
        at: new Date().toISOString(),
      });
    }
    return report;
  }
}
