/**
 * tests/exec-build-context.test.ts —— §3.2 内存构建上下文回归。
 *
 * 断言 buildContextTar(repoRoot)：
 *   1) 产物是合法 gzip 流，解开后是合法 tar；
 *   2) 条目恰为 Dockerfile（源 exec-image/）+ agent-runtime/**（排除 node_modules/dist/.gitkeep）；
 *   3) Dockerfile 内容非空（防上下文根指错时无声打空包）。
 * 不打 docker——纯本机 fs + tar-stream 逻辑（dockerode 的传递依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildContextTar } from '../src/exec/fleet.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url))); // tests/ → dotd/

async function listTarEntries(gz: Buffer): Promise<{ names: string[]; dockerfileBytes: number }> {
  const tarMod = (await import('tar-stream')) as unknown as { default: { extract(): any } };
  const out = zlib.gunzipSync(gz);
  const names: string[] = [];
  let dockerfileBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const ex = tarMod.default.extract();
    ex.on('entry', (h: { name: string }, rs: { resume(): void; on(ev: string, cb: (c?: any) => void): void }, next: () => void) => {
      names.push(h.name);
      const bufs: Buffer[] = [];
      rs.on('data', (c: Buffer) => bufs.push(c));
      rs.on('end', () => {
        if (h.name === 'Dockerfile') dockerfileBytes = Buffer.concat(bufs).length;
        next();
      });
      rs.resume();
    });
    ex.on('finish', () => resolve());
    ex.on('error', reject);
    ex.end(out);
  });
  return { names, dockerfileBytes };
}

test('buildContextTar 打包 Dockerfile + agent-runtime 源码（内存，不落盘）', async () => {
  const gz = await buildContextTar(repoRoot);
  assert.ok(gz.length > 0, 'tar.gz 非空');
  const { names, dockerfileBytes } = await listTarEntries(gz);

  assert.ok(names.includes('Dockerfile'), '含 Dockerfile 条目');
  assert.ok(names.includes('agent-runtime/server.ts'), '含 agent-runtime/server.ts');
  assert.ok(names.includes('agent-runtime/package.json'), '含 agent-runtime/package.json');
  assert.ok(names.includes('agent-runtime/package-lock.json'), '含 npm ci 依赖的 package-lock.json');
  assert.ok(dockerfileBytes > 500, `Dockerfile 内容完整（${dockerfileBytes} 字节）`);
  assert.ok(!names.some((n) => n.includes('node_modules/')), '排除 node_modules');
  assert.ok(!names.some((n) => n.includes('/dist/')), '排除 dist');
});
