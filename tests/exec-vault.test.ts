/**
 * tests/exec-vault.test.ts —— A2 集成：runTool 顶部的 $vault: 替换与回包清洗。
 *
 * 真实 ExecServiceImpl + 宿主工具探针：占位符进、明文到工具手、结果出去前明文
 * 被洗回占位符；缺条目 vault_missing；没配钥匙 vault_unconfigured。
 */
import assert from 'node:assert/strict';
// 2026-10-22 修（Windows）：原来直接 rmSync 会在 Windows 上报 EPERM
// （SQLite 的 WAL/SHM 句柄还打着，删不掉）→ 整个测试报红。
// 改用 helpers 的 forceRemoveTempPath（内存带重试）。
import { forceRemoveTempPath } from './helpers.ts';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { vaultPut } from '../src/vault/vault.ts';

const KEY32 = Buffer.alloc(32, 11).toString('base64');
const SECRET = 'REAL-SECRET-XYZ-42';

test('exec：$vault: 占位符在宿主工具手上已是明文；回包被清洗', async () => {
  const t = makeTempDataDir();
  const savedKey = process.env.DOTD_MAIL_KEY;
  const savedDir = process.env.DOTD_VAULT_DIR;
  process.env.DOTD_MAIL_KEY = KEY32;
  process.env.DOTD_VAULT_DIR = t.root;
  try {
    vaultPut(t.root, KEY32, 'example.com', 'alice', SECRET);
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    let seen: unknown = null;
    svc.registerHostTool('vault.probe', async (args) => {
      seen = args;
      return { ok: true as const, value: { echo: (args as { pass: string }).pass } };
    });

    const call = {
      call_id: 'c-vault-1',
      dot_id: 'dot-a',
      task_id: 't1',
      tool: 'vault.probe' as never,
      args: { user: 'alice', pass: '$vault:example.com:alice' },
      deadline_ms: 1_000,
      issued_at: '2026-10-21T00:00:00Z',
    };

    const r = await svc.runTool(call);
    assert.equal(r.status, 'ok');
    assert.equal((seen as { pass: string } | null)?.pass, SECRET, '工具应拿到明文');
    // 回包（echo 回明文）必须被洗掉
    assert.ok(!JSON.stringify(r).includes(SECRET), '结果不得含明文');
    assert.ok(JSON.stringify(r).includes('$vault:redacted'));

    // 原始 args 对象不被原地改（journal 落的是占位符）
    assert.equal((call.args as { pass: string }).pass, '$vault:example.com:alice');
  } finally {
    if (savedKey === undefined) delete process.env.DOTD_MAIL_KEY;
    else process.env.DOTD_MAIL_KEY = savedKey;
    if (savedDir === undefined) delete process.env.DOTD_VAULT_DIR;
    else process.env.DOTD_VAULT_DIR = savedDir;
    forceRemoveTempPath(t.root);
  }
});

test('exec：缺条目 → vault_missing（fail-closed，占位符不出门）', async () => {
  const t = makeTempDataDir();
  const savedKey = process.env.DOTD_MAIL_KEY;
  const savedDir = process.env.DOTD_VAULT_DIR;
  process.env.DOTD_MAIL_KEY = KEY32;
  process.env.DOTD_VAULT_DIR = t.root;
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const r = await svc.runTool({
      call_id: 'c-vault-2',
      dot_id: 'dot-a',
      task_id: 't1',
      tool: 'vault.probe' as never,
      args: { pass: '$vault:nope.com:u' },
      deadline_ms: 1_000,
      issued_at: '2026-10-21T00:00:00Z',
    });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'vault_missing');
    assert.ok(r.error?.message.includes('nope.com'));
  } finally {
    if (savedKey === undefined) delete process.env.DOTD_MAIL_KEY;
    else process.env.DOTD_MAIL_KEY = savedKey;
    if (savedDir === undefined) delete process.env.DOTD_VAULT_DIR;
    else process.env.DOTD_VAULT_DIR = savedDir;
    forceRemoveTempPath(t.root);
  }
});

test('exec：有占位符但没配钥匙 → vault_unconfigured', async () => {
  const t = makeTempDataDir();
  const savedKey = process.env.DOTD_MAIL_KEY;
  delete process.env.DOTD_MAIL_KEY;
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const r = await svc.runTool({
      call_id: 'c-vault-3',
      dot_id: 'dot-a',
      task_id: 't1',
      tool: 'vault.probe' as never,
      args: { pass: '$vault:a.com:u' },
      deadline_ms: 1_000,
      issued_at: '2026-10-21T00:00:00Z',
    });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'vault_unconfigured');
  } finally {
    if (savedKey !== undefined) process.env.DOTD_MAIL_KEY = savedKey;
    forceRemoveTempPath(t.root);
  }
});
