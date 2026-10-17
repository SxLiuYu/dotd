import assert from 'node:assert/strict';
import test from 'node:test';
import { makeExecFsOpsBridge, type ExecFsOpsLike } from '../src/memory/exec-fsops-bridge.ts';
import type { FsOpsRequest, FsOpsResponse } from '../src/exec/types.ts';

const HOME_ROOT = '/dot/home';

function fakeExec(
  handler: (dotId: string, req: FsOpsRequest) => FsOpsResponse | never,
): ExecFsOpsLike & { seen: Array<{ dotId: string; req: FsOpsRequest }> } {
  const seen: Array<{ dotId: string; req: FsOpsRequest }> = [];
  return {
    seen,
    async fsOps(dotId, req) {
      seen.push({ dotId, req });
      return handler(dotId, req);
    },
  };
}

/** 取第 n 条被桥转译后的请求（noUncheckedIndexedAccess 下显式判空）。 */
function nth(seen: Array<{ dotId: string; req: FsOpsRequest }>, n: number): FsOpsRequest {
  const hit = seen[n];
  if (hit === undefined) throw new Error(`第 ${n} 条 fsOps 调用不存在（共 ${seen.length} 条）`);
  return hit.req;
}

const ok = (over: Partial<FsOpsResponse> = {}): FsOpsResponse => ({ op: 'read', ok: true, ...over });

test('exec-fsops 桥：相对路径必须换成 home 绝对路径（否则每读一次 memory_missed）', async () => {
  const exec = fakeExec((_d, req) => ok({ content: '# MEMORY\n', op: req.op }));
  const bridge = makeExecFsOpsBridge(exec);
  assert.equal(bridge.kind, 'exec-fsops');
  assert.equal(bridge.available(), true);

  const text = await bridge.read('dot1', 'MEMORY.md');
  assert.equal(text, '# MEMORY\n');
  assert.equal(nth(exec.seen, 0).path, `${HOME_ROOT}/MEMORY.md`, '相对路径没转成 home 绝对路径');

  await bridge.stat('dot1', 'notes/a.md');
  assert.equal(nth(exec.seen, 1).path, `${HOME_ROOT}/notes/a.md`);

  await bridge.list('dot1', 'notes');
  assert.equal(nth(exec.seen, 2).path, `${HOME_ROOT}/notes`);

  await bridge.rename('dot1', 'a.md', 'b.md');
  assert.equal(nth(exec.seen, 3).path, `${HOME_ROOT}/a.md`);
  assert.equal(nth(exec.seen, 3).target, `${HOME_ROOT}/b.md`);
});

test('exec-fsops 桥：已是 home 绝对路径时原样透传（不重复前缀）', async () => {
  const exec = fakeExec((_d, req) => ok({ content: 'x', op: req.op }));
  const bridge = makeExecFsOpsBridge(exec);
  await bridge.read('dot1', `${HOME_ROOT}/MEMORY.md`);
  assert.equal(nth(exec.seen, 0).path, `${HOME_ROOT}/MEMORY.md`);
});

test('exec-fsops 桥：容器瞬时不可达（fsOps 抛异常）一律降级，绝不炸调用方', async () => {
  const exec: ExecFsOpsLike = {
    async fsOps() {
      throw new Error('runtime client unavailable');
    },
  };
  const bridge = makeExecFsOpsBridge(exec);
  assert.equal(await bridge.read('dot1', 'MEMORY.md'), null, 'read 失败应返 null');
  assert.deepEqual(await bridge.list('dot1', 'notes'), [], 'list 失败应返空数组');
  assert.equal(await bridge.stat('dot1', 'a.md'), null, 'stat 失败应返 null');
  assert.equal(await bridge.rename('dot1', 'a.md', 'b.md'), false, 'rename 失败应返 false');
});

test('exec-fsops 桥：ok:false 与缺字段都按"没有"处理，不当成内容', async () => {
  const exec = fakeExec((_d, req) => {
    if (req.op === 'read') return { op: 'read', ok: false };
    if (req.op === 'list') return { op: 'list', ok: true, entries: undefined };
    if (req.op === 'stat') return { op: 'stat', ok: true };
    return { op: 'rename', ok: false };
  });
  const bridge = makeExecFsOpsBridge(exec);
  assert.equal(await bridge.read('dot1', 'MEMORY.md'), null);
  assert.deepEqual(await bridge.list('dot1', 'notes'), []);
  assert.equal(await bridge.stat('dot1', 'a.md'), null);
  assert.equal(await bridge.rename('dot1', 'a.md', 'b.md'), false);
});

test('exec-fsops 桥：list/stat 字段双写（size/sizeBytes、mtime/mtimeMs）都能取到值', async () => {
  const exec = fakeExec((_d, req) => {
    if (req.op === 'list') {
      return {
        op: 'list',
        ok: true,
        entries: [
          { name: 'a.md', type: 'file', size: 12, mtime: '2026-10-17T00:00:00.000Z' },
          { name: 'sub', path: 'sub', type: 'dir', sizeBytes: 0, mtimeMs: 1 },
        ],
      };
    }
    return { op: 'stat', ok: true, stat: { path: 'a.md', type: 'file', size: 12 } };
  });
  const bridge = makeExecFsOpsBridge(exec);
  const list = await bridge.list('dot1', '.');
  assert.equal(list.length, 2);
  const file = list[0];
  const dir = list[1];
  if (file === undefined || dir === undefined) throw new Error('list 应返回两条');
  assert.equal(file.path, 'a.md');
  assert.equal(file.type, 'file');
  assert.equal(file.sizeBytes, 12);
  assert.equal(file.mtimeMs, Date.parse('2026-10-17T00:00:00.000Z'));
  assert.equal(dir.path, 'sub');
  assert.equal(dir.type, 'dir');

  const st = await bridge.stat('dot1', 'a.md');
  assert.ok(st !== null);
  assert.equal(st.path, 'a.md');
  assert.equal(st.sizeBytes, 12);
  assert.equal(st.isDir, false);
});
