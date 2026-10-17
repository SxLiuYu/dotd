import { toHomeAbs } from '../exec/protocol.ts';
import type { FsOpsRequest, FsOpsResponse } from '../exec/types.ts';
import type { FsOpsBridge, FsOpsListEntry, FsOpsStat } from './fsops-client.ts';

/** 只依赖 ExecService 的 fsOps 一个方法——便于测试替身。 */
export interface ExecFsOpsLike {
  fsOps(dotId: string, req: FsOpsRequest): Promise<FsOpsResponse>;
}

/**
 * 装配期把 ExecService.fsOps 包成记忆模块的 FsOpsBridge（kind='exec-fsops'）。
 *
 * 两处口径差异都在这一个函数里收口：
 *
 * 1. **路径**：FsOpsBridge 契约用 home **相对**路径（inject.ts 的 readMemoryMd
 *    传 'MEMORY.md'），而 ExecService.fsOps 的宿主侧护栏 checkHomePath 只认
 *    `/dot/home/` 前缀的**绝对**路径。缺这一步转换时每一次记忆读取都被
 *    path_outside_home 拒掉，表现为 buildContextBundle 恒降级 + memory_missed
 *    每任务一条（2026-10-17 实测）。
 * 2. **失败语义**：FsOpsBridge 契约要求任何失败都降级为 null / 空数组 /
 *    false，绝不抛（fsops-client.ts 顶部："不炸主循环"）。ExecService.fsOps 在
 *    runtime 客户端缺失、容器瞬时不可达时是**抛异常**的，裸调会把一次瞬时
 *    故障升级成整任务失败，而不是记一条 memory_missed（2026-10-17 实测）。
 */
export function makeExecFsOpsBridge(exec: ExecFsOpsLike): FsOpsBridge {
  const homeAbs = toHomeAbs;
  const safe = async (
    dotId: string,
    req: FsOpsRequest,
  ): Promise<FsOpsResponse | null> => {
    try {
      return await exec.fsOps(dotId, req);
    } catch {
      return null;
    }
  };
  return {
    kind: 'exec-fsops',
    // 可达性由调用方按需探测（FsOpsHttpBridge 同款保守口径）
    available: () => true,
    read: async (dotId, path) => {
      const r = await safe(dotId, { op: 'read', path: homeAbs(path) });
      return r?.content ?? null;
    },
    list: async (dotId, path) => {
      const r = await safe(dotId, { op: 'list', path: homeAbs(path) });
      if (r === null) return [];
      return (r.entries ?? []).map((e): FsOpsListEntry => ({
        path: e.path ?? e.name,
        name: e.name,
        type: e.type === 'dir' ? 'dir' : 'file',
        sizeBytes: e.sizeBytes ?? e.size,
        mtimeMs: e.mtimeMs ?? (e.mtime === undefined ? undefined : Date.parse(e.mtime)),
      }));
    },
    stat: async (dotId, path) => {
      const r = await safe(dotId, { op: 'stat', path: homeAbs(path) });
      const st = r?.stat;
      if (st === undefined) return null;
      const out: FsOpsStat = {
        path: st.path ?? path,
        sizeBytes: st.sizeBytes ?? st.size ?? 0,
        mtimeMs: st.mtimeMs ?? (st.mtime === undefined ? 0 : Date.parse(st.mtime)),
        isDir: st.isDir ?? st.type === 'dir',
      };
      return out;
    },
    rename: async (dotId, from, to) => {
      const r = await safe(dotId, { op: 'rename', path: homeAbs(from), target: homeAbs(to) });
      return r?.ok === true;
    },
  };
}
