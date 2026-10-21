/**
 * src/exec/image.ts —— ImageManager（execution.md §3.2 构建流程）。
 *
 * 职责（E1 的镜像半边）：
 *  - ensureImage()：tag = `dotd/exec:{PW_VERSION}-{runtimeVer}`；docker images 已含 tag 且
 *    image_builds 有 status='ready' 行 → 秒回 digest；否则构建并落库。
 *  - 构建锁（进程内互斥，防并发双建）；日志逐行经 EventBus.emit('exec.image.build') 外抛
 *    （本模块对外事件名表见 §10；build 日志另走 'exec.image.build'，骨架 TOPICS 未登记该名，
 *    按 bus.ts 约定未知 topic 归 'log' 通道，可订阅）。
 *  - 构建成功后触发 §8 镜像回收（删旧 tag，保留 digest 引用中的除外）。
 *  - 失败：image_builds status='failed'，容器生命周期状态机进 build_failed。
 *
 * stub 模式（DOTD_FLEET=stub）：不起 Docker、不打 tar，镜像"已存在"由内存后端伪造，
 * 保证状态机与 ledger 语义不变。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type { ContainerBackend, ExecConfig, ImageBuildRow } from './types.ts';
import { imageTag } from './protocol.ts';

export interface ImageManagerDeps {
  db: DatabaseSync;
  bus: EventBus;
  cfg: ExecConfig;
  backend: ContainerBackend;
}

export interface EnsureImageResult {
  tag: string;
  digest: string | null;
  ready: boolean;
  /** true = 本次实际触发了构建（测试/审计用）。 */
  built: boolean;
}

/**
 * 是否是 stub 后端伪造的占位 digest（全零 sha256）。
 *
 * stub fleet 不起 Docker，但它要满足"镜像就绪"的状态机，于是写了一条 ready 记录、
 * digest 用全零占位。这个值一旦被真实 dockerode 拿去 createContainer，就会得到
 * `No such image: sha256:000…0`——而且因为 ready 记录被当成"已构建"，
 * **rebuild 永远不会触发**，boot 每次都失败且看不出原因。
 *
 * 判据只认"全零"，不做其它猜测：真实镜像 ID 不可能全零。
 */
export function isPlaceholderDigest(digest: string | null | undefined): boolean {
  if (typeof digest !== 'string') return false;
  const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return /^0+$/.test(hex);
}

export class ImageManager {
  /** 进程内构建锁（§3.2：防并发双建）。 */
  private building: Promise<EnsureImageResult> | null = null;

  constructor(private readonly deps: ImageManagerDeps) {}

  /** 当前生效镜像 tag（§3.2）。 */
  currentTag(): string {
    const { pwVersion, runtimeVer } = this.deps.cfg;
    return imageTag(pwVersion, runtimeVer);
  }

  /**
   * image_builds 中该 tag 的最新 **可用** ready 行。
   *
   * 什么算"不可用"：stub 后端伪造的 digest（全零 sha256）。见 `isPlaceholderDigest`。
   */
  readyBuild(tag: string): ImageBuildRow | null {
    const rows = this.deps.db
      .prepare("SELECT * FROM image_builds WHERE tag = ? AND status = 'ready' ORDER BY id DESC")
      .all(tag) as unknown as ImageBuildRow[];
    // 跳过占位 digest：stub 模式下写进来的全零 sha256 不是真镜像，拿它去
    // `docker create` 会得到 "No such image: sha256:000…0"。
    // 2026-10-18 真实踩到：库是历史遗留的（先从 stub 跑过），切到 DOTD_FLEET=docker 后
    // boot 连报两次 "boot 失败 … No such image"，容器永远起不来。
    return rows.find((r) => !isPlaceholderDigest(r.digest)) ?? null;
  }

  /** 历史 ready 行（§8 镜像回收：保留 digest 引用中的除外）。 */
  readyBuilds(): ImageBuildRow[] {
    return this.deps.db
      .prepare("SELECT * FROM image_builds WHERE status = 'ready' ORDER BY id DESC")
      .all() as unknown as ImageBuildRow[];
  }

  /**
   * ensureImage()（§3.2 逐行落地）。
   * 已 ready 且镜像在 → 秒回；否则持锁构建（并发调用共享同一次构建）。
   */
  async ensureImage(): Promise<EnsureImageResult> {
    const tag = this.currentTag();
    const ready = this.readyBuild(tag);
    if (ready !== null && (await this.deps.backend.hasImage(tag))) {
      return { tag, digest: ready.digest, ready: true, built: false };
    }
    if (this.building !== null) return this.building;
    const p = this.build(tag);
    this.building = p;
    try {
      return await p;
    } finally {
      this.building = null;
    }
  }

  /** 真正构建（stub 下由后端伪造"镜像存在"）。 */
  private async build(tag: string): Promise<EnsureImageResult> {
    const cfg = this.deps.cfg;
    const startedAt = new Date().toISOString();
    const ins = this.deps.db
      .prepare(
        `INSERT INTO image_builds (tag, digest, pw_version, status, log_tail, started_at, finished_at)
         VALUES (?, NULL, ?, 'building', NULL, ?, NULL)`,
      )
      .run(tag, cfg.pwVersion, startedAt);
    const buildId = Number(ins.lastInsertRowid);
    const lines: string[] = [];

    const onLine = (line: string): void => {
      lines.push(line);
      this.deps.bus.publish('exec.image.build', { tag, line });
    };

    try {
      // 这几行是构建开始前的摘要，不是 docker 的真实输出（真实输出由 buildImage
      // 逐行推过来）。2026-10-21 换基座时它们全错了——还写着 playwright、xvfb、
      // userdel ubuntu，实际早就不是那样。摘要一旦和 Dockerfile 脱节，排障时会
      // 把人带到错方向，所以改成照实描述当前 Dockerfile 的形状。
      onLine('Step 1/4 : FROM node:24-slim（基座，2026-10-21 换掉 playwright 基座）');
      onLine('Step 2/4 : RUN apt-get install bash poppler-utils git python3');
      onLine('Step 3/4 : COPY agent-runtime/ → npm ci + tsc + prune');
      onLine(`Step 4/4 : userdel node + useradd dot(1000)/shell(1001) → USER dot / EXPOSE ${cfg.runtimePort}`);
      const r = await this.deps.backend.buildImage(tag, cfg.pwVersion, onLine);
      const finishedAt = new Date().toISOString();
      this.deps.db
        .prepare("UPDATE image_builds SET status = 'ready', digest = ?, log_tail = ?, finished_at = ? WHERE id = ?")
        .run(r.digest, tail(lines, cfg.logTailChars), finishedAt, buildId);
      // 旧 tag 降级 + 触发 §8 镜像回收
      await this.reapOldImages(tag, r.digest);
      return { tag, digest: r.digest, ready: true, built: true };
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      this.deps.db
        .prepare("UPDATE image_builds SET status = 'failed', log_tail = ?, finished_at = ? WHERE id = ?")
        .run(tail([...lines, `FAILED: ${msg}`], cfg.logTailChars), new Date().toISOString(), buildId);
      return { tag, digest: null, ready: false, built: true };
    }
  }

  /**
   * §8 镜像回收：构建成功后把其余 ready 行标 superseded，并 docker 删旧 `dotd/exec:*` tag
   * （保留 digest 引用中的除外）。只动镜像 tag，不碰容器/卷。
   */
  private async reapOldImages(currentTag: string, currentDigest: string): Promise<void> {
    const db = this.deps.db;
    const stale = this.readyBuilds().filter((b) => b.tag !== currentTag && b.digest !== currentDigest);
    for (const b of stale) {
      db.prepare("UPDATE image_builds SET status = 'superseded' WHERE id = ?").run(b.id);
      try {
        await this.deps.backend.removeImage(b.tag);
      } catch {
        // 删除失败不阻塞构建成功（下轮 DiskGardener 再收）
      }
    }
    this.deps.bus.publish('exec.disk.gardened', {
      freedMb: 0,
      steps: [`image_prune:${stale.length}`],
      at: new Date().toISOString(),
    });
  }

  /** 把容器生命周期推到 build_failed（§3.2 失败路径；由 ExecService 调）。 */
  markBuildFailed(dotId: string): void {
    void dotId;
    // 状态机迁移由 Fleet.transition 承担（避免本文件反向依赖 Fleet）；
    // 这里只留事件痕迹，供装配层/审计读取。
    this.deps.bus.publish('exec.image.build', { tag: this.currentTag(), line: 'build_failed' });
  }
}

function tail(lines: string[], max: number): string {
  const s = lines.join('\n');
  return s.length <= max ? s : s.slice(s.length - max);
}
