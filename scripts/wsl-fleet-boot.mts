/**
 * WSL fleet 启动验证（生产路径，不经模型）：
 *   openDb + migrate → ExecServiceImpl(DOTD_FLEET=docker) → boot(['dot1'])
 *   → 真容器创建/启动/healthcheck → fsOps 写文件 → docker exec 从卷读回验证落盘。
 *
 * 跑法（WSL，仓库根）：
 *   DOTD_FLEET=docker DOTD_REPO_ROOT=/root/dotd node --import tsx scripts/wsl-fleet-boot.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '../db/conn.ts';
import { migrate, latestMigrationVersion } from '../db/migrate.ts';
import { EventBus } from '../src/shared/bus.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { execConfigFromEnv } from '../src/exec/types.ts';

const dataDir = join(homedir(), '.dotd');
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'fleet-verify.db'));
// expectedVersion 从迁移目录推（2026-10-22）：这里钉死 50 已经让本脚本在
// 迁移 60 之后就一直起不来 —— 实测 MigrationError: 迁移后 user_version=185，期望 50。
// README:350 记录的正是这条"生产路径不经模型"的验证入口，它静默坏掉比没有更糟。
const res = migrate(db, { expectedVersion: latestMigrationVersion() });
console.log(`migrate ${res.from}→${res.to}`);

const bus = new EventBus();
const cfg = { ...execConfigFromEnv(), tokenDir: join(dataDir, 'exec-tokens') };
console.log('fleet mode:', cfg.fleet);
if (cfg.fleet !== 'docker') {
  console.error('需要 DOTD_FLEET=docker');
  process.exit(1);
}
const exec = new ExecServiceImpl({ db, bus, cfg });

const t0 = Date.now();
const report = await exec.boot(['dot1']);
console.log(`boot 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）:`);
console.log(JSON.stringify(report, null, 2));

const row = exec.fleet.getContainer('dot1');
console.log('container row:', JSON.stringify({ state: row?.state, endpoint: row?.endpoint, docker: row?.docker_container_id?.slice(0, 12) }));

// fs.write 走模型工具面（runTool）：宿主 → 容器 /call，Bearer token，§7 硬护栏
const stamp = new Date().toISOString();
const content = `fleet real landing @ ${stamp}\n`;
const w = await exec.runTool({
  call_id: `fc_verify_${Date.now()}`,
  task_id: 'task_verify',
  dot_id: 'dot1',
  tool: 'fs.write',
  args: { path: '/dot/home/fleet-verify.txt', content },
  deadline_ms: 30_000,
  issued_at: stamp,
} as never);
console.log('runTool fs.write:', JSON.stringify(w).slice(0, 400));

// 读回验证：docker exec 直接看卷上文件（不经容器 API，独立证据）
try {
  const out = execFileSync('docker', ['exec', 'dotd-dot-dot1', 'cat', '/dot/home/fleet-verify.txt'], { encoding: 'utf8' });
  console.log('volume read-back OK:', JSON.stringify(out.trim()));
} catch (e) {
  console.log('volume read-back FAILED:', String(e).slice(0, 200));
}

// fsOps read 走宿主注入桥（Bearer 鉴权、不进模型面）
const read = await exec.fsOps('dot1', { op: 'read', path: '/dot/home/fleet-verify.txt' });
console.log('fsOps read:', JSON.stringify(read).slice(0, 300));

db.close();
process.exit(read.ok === true ? 0 : 1);
