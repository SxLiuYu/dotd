/**
 * tests/vault.test.ts —— A2 密码保险库（2026-10-21）。
 *
 * 覆盖：加解密往返 / 坏钥匙 fail-closed / 列表不带值 / $vault: 替换（嵌套+数组+缺条目）
 * / 回包清洗（含零拷贝路径）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decodeKey,
  vaultDelete,
  vaultGet,
  vaultList,
  vaultPut,
} from '../src/vault/vault.ts';
import { scrubSecrets, substituteVaultArgs } from '../src/vault/substitute.ts';

const KEY32 = Buffer.alloc(32, 7).toString('base64'); // 32B 测试钥匙
const KEYOTHER = Buffer.alloc(32, 9).toString('base64');

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), 'dotd-vault-test-'));
}

test('保险库：写入→读取往返，明文只进密文文件', () => {
  const dir = tmpVault();
  try {
    vaultPut(dir, KEY32, 'example.com', 'alice', 'p@ss w0rd!');
    assert.equal(vaultGet(dir, KEY32, 'example.com', 'alice'), 'p@ss w0rd!');
    // 覆盖写
    vaultPut(dir, KEY32, 'example.com', 'alice', 'new-secret');
    assert.equal(vaultGet(dir, KEY32, 'example.com', 'alice'), 'new-secret');
    // 文件里找不到明文
    const raw = readRaw(dir);
    assert.ok(!raw.includes('new-secret') && !raw.includes('p@ss'), 'vault.json 不得含明文');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('保险库：钥匙不对 → 解密失败（fail-closed，不返回垃圾）', () => {
  const dir = tmpVault();
  try {
    vaultPut(dir, KEY32, 'example.com', 'bob', 'secret-b');
    assert.throws(() => vaultGet(dir, KEYOTHER, 'example.com', 'bob'));
    assert.equal(vaultGet(dir, KEYOTHER.replace('=', '') + '=', 'x', 'y'), null); // 没有条目
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('保险库：list 只有 site/user；delete 报告是否真删', () => {
  const dir = tmpVault();
  try {
    vaultPut(dir, KEY32, 'a.com', 'u1', 's1');
    vaultPut(dir, KEY32, 'b.com', 'u2', 's2');
    assert.deepEqual(vaultList(dir), [
      { site: 'a.com', user: 'u1' },
      { site: 'b.com', user: 'u2' },
    ]);
    assert.equal(vaultDelete(dir, 'a.com', 'u1'), true);
    assert.equal(vaultDelete(dir, 'a.com', 'u1'), false); // 再删 = 没删
    assert.equal(vaultGet(dir, KEY32, 'a.com', 'u1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decodeKey：非 32 字节 fail-fast', () => {
  assert.throws(() => decodeKey(Buffer.alloc(16).toString('base64')));
  assert.throws(() => decodeKey('not-base64!!'));
  assert.equal(decodeKey(KEY32).length, 32);
});

test('substituteVaultArgs：嵌套对象/数组都替换，缺条目原样保留并上报', () => {
  const lookup = (site: string, user: string): string | null =>
    site === 'example.com' && user === 'alice' ? 'REAL-SECRET' : null;
  const args = {
    tool: 'browser.act',
    args: {
      actions: [
        { type: 'fill', selector: '#user', text: 'alice' },
        { type: 'fill', selector: '#pass', text: '$vault:example.com:alice' },
        { type: 'fill', selector: '#otp', text: '$vault:other.com:alice' },
      ],
      n: 3,
      flag: true,
      nil: null,
    },
  };
  const out = substituteVaultArgs(args, lookup);
  const acts = (out.args as typeof args).args.actions as Array<Record<string, unknown>>;
  assert.equal(acts[0]?.text, 'alice');
  assert.equal(acts[1]?.text, 'REAL-SECRET');
  assert.equal(acts[2]?.text, '$vault:other.com:alice');
  assert.deepEqual(out.missing, ['$vault:other.com:alice']);
  assert.deepEqual(out.secrets, ['REAL-SECRET']);
  // 原对象不动
  const origActs = args.args.actions as Array<Record<string, unknown>>;
  assert.equal(origActs[1]?.text, '$vault:example.com:alice');
});

test('scrubSecrets：明文从序列化形态里抹掉；无明文走零拷贝', () => {
  const r1 = { status: 'ok', result: { echo: 'REAL-SECRET', n: 1 } };
  const s1 = scrubSecrets(r1, ['REAL-SECRET']);
  assert.equal((s1.result as Record<string, unknown>).echo, '$vault:redacted');
  assert.equal((s1.result as Record<string, unknown>).n, 1);
  const r2 = { status: 'ok', n: 2 };
  assert.equal(scrubSecrets(r2, []), r2); // 零拷贝
  // 错误消息里的明文也洗
  const e1 = { status: 'error', error: { code: 'x', message: 'bad REAL-SECRET here' } };
  const s2 = scrubSecrets(e1, ['REAL-SECRET']);
  assert.ok(!JSON.stringify(s2).includes('REAL-SECRET'));
});

test('长明文包含短明文时：先洗长串不破坏短串', () => {
  const out = scrubSecrets({ v: 'AABBCC' }, ['AAB', 'AABBCC']);
  assert.equal((out as { v: string }).v, '$vault:redacted');
});

/** 读原始文件内容（小助手，仅测试用）。 */
function readRaw(dir: string): string {
  return readFileSync(join(dir, 'vault.json'), 'utf8');
}
