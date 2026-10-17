/**
 * src/exec/dockerode.d.ts —— dockerode 的最小类型声明。
 *
 * 背景（契约 J5 / execution.md §2.1-1）：容器 stats 与全部容器操作走 dockerode 的 API，
 * **不写 docker CLI 子进程**。dockerode 5.0.1 在 package.json 里不带 "types"，仓库也没有
 * 装 @types/dockerode（CONVENTIONS.md：不新增 npm 依赖），因此本文件只声明**本模块真正
 * 调用到的最小形状**，并让 `import('dockerode')` 动态加载在有/无类型的环境下都能通过
 * `tsc --noEmit`。
 *
 * 这是本模块私有的实现细节声明，不是跨模块契约；真实行为仍由部署环境的 dockerd 验证。
 */

declare module 'dockerode' {
  export interface DockerOptions {
    socketPath?: string;
    host?: string;
    port?: number | string;
    version?: string;
  }

  interface ContainerHandle {
    start(): Promise<unknown>;
    pause(): Promise<unknown>;
    unpause(): Promise<unknown>;
    stop(options?: unknown): Promise<unknown>;
    remove(options?: unknown): Promise<unknown>;
    inspect(): Promise<unknown>;
    stats(options?: unknown): Promise<unknown>;
  }

  interface NetworkHandle {
    inspect(): Promise<unknown>;
  }

  interface VolumeHandle {
    inspect(): Promise<unknown>;
    remove(): Promise<unknown>;
  }

  interface ImageHandle {
    remove(): Promise<unknown>;
  }

  interface ImageInfo {
    Id?: string;
    RepoTags?: string[] | null;
    Size?: number;
    Labels?: Record<string, string> | null;
  }

  interface ContainerListItem {
    Id: string;
    Names?: string[];
    Image?: string;
    State?: string;
    Status?: string;
    Labels?: Record<string, string>;
  }

  interface ContainerInspect {
    Id?: string;
    Name?: string;
    State?: {
      Status?: string;
      Running?: boolean;
      Paused?: boolean;
      ExitCode?: number;
      StartedAt?: string;
      Error?: string;
    };
    Config?: { Labels?: Record<string, string> };
  }

  interface NetworkInspect {
    Name?: string;
    Id?: string;
    IPAM?: {
      Config?: Array<{ Subnet?: string; Gateway?: string }>;
    };
    Containers?: Record<string, unknown>;
  }

  interface VolumeInspect {
    Name?: string;
    Mountpoint?: string;
    UsageData?: { Size?: number };
    Labels?: Record<string, string>;
  }

  interface VolumeListItem {
    Name?: string;
    Driver?: string;
    Mountpoint?: string;
    Labels?: Record<string, string> | null;
    UsageData?: { Size?: number } | null;
  }

  interface ContainerStats {
    memory_stats?: { usage?: number; limit?: number };
    cpu_stats?: { cpu_usage?: { total_usage?: number } };
    networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  }

  interface Docker {
    ping(): Promise<unknown>;
    version(): Promise<{ ApiVersion?: string; Version?: string }>;
    listImages(): Promise<ImageInfo[]>;
    listContainers(options?: unknown): Promise<ContainerListItem[]>;
    createContainer(options: unknown): Promise<ContainerHandle>;
    getContainer(id: string): ContainerHandle;
    getNetwork(name: string): NetworkHandle;
    getVolume(name: string): VolumeHandle;
    getImage(tag: string): ImageHandle;
    buildImage(tar: unknown, options?: unknown): Promise<unknown>;
    /** `docker volume ls`（EX §8 步骤②：无主卷枚举源）。 */
    listVolumes(options?: unknown): Promise<{ Volumes?: VolumeListItem[] }>;
    /**
     * `docker builder prune -f`（EX §8 步骤②：回收构建缓存）。
     * dockerode 把 system/df 的 builder 修剪暴露在 pruneBuilders/builderPrune；
     * 不同版本形状不一，此处按 unknown 收下由调用方解析 CachesDeleted/SpaceReclaimed。
     */
    builderPrune?(options?: unknown): Promise<unknown>;
    pruneBuilders?(options?: unknown): Promise<unknown>;
    df(): Promise<unknown>;
    modem: unknown;
  }

  const Docker: {
    new (options?: DockerOptions): Docker;
    (options?: DockerOptions): Docker;
    prototype: Docker;
  };

  export default Docker;
}
