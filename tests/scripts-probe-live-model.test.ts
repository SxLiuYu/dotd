/**
 * tests/scripts-probe-live-model.test.ts —— 上线前体检的取 key 顺序，要按 daemon 的眼光问。
 *
 * 现场（2026-10-26 live，修完 §18.13/18.14 之后）：
 *
 * ```
 * $ node --import tsx scripts/probe-live-model.mjs
 * connect:  未验证 — 环境变量 HY3_API_KEY 不存在或为空
 * ```
 *
 * 而同一时刻 daemon 的进程环境里有它（`tr '\0' '\n' < /proc/<pid>/environ` 可见），
 * 模型正常出字。检查器只看自己那个 shell，然后把"我没看见"报成"没配"——
 * 与 §18.11–18.14 同一个缺陷的第五例。
 *
 * 现在的判据是三处：**进程环境 → `<home>/tokens.env` → 运行中 daemon 的进程环境**。
 * 这里用**真脚本 + 假网关**把三件容易写错的事钉住：
 *   ① 顺序：shell 里有就用 shell 的，不被文件里的旧值盖掉；
 *   ② 落地：从文件里找到的 key 必须写回 `process.env` —— `HttpTransport.apiKeyFor()`
 *      在发请求时另取一次，只认 `process.env`，否则"找到了"等于没找到；
 *   ③ 不泄露：key 的值绝不出现在输出里，只说"从哪儿来"。
 *
 * 端口固定 7799、home/config 全在临时目录（与既有冒烟约定一致，不碰线上 7788）。
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const PORT = 7799;
const KEY = 'probe-key-SHOULD-NEVER-APPEAR-0123456789';

/** 假网关：只认 `Bearer <期望值>`，回一个合法 tool_calls（名字用消毒后的 fs_read）。 */
function startFakeGateway(expectKey: string): Promise<{ server: Server; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    seen.push(auth);
    if (auth !== `Bearer ${expectKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion',
        model: 'deepseek-v4.1-flash',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'fs_read', arguments: '{"path":"notes/probe.md"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({ server, seen })));
}

/** 临时 home + 临时 config：models.yml 直接抄仓库那份，端点地址由 DOTD_MODEL_HOST 注入。 */
function makeWorld(tokensEnv: string, home: string, configDir: string): void {
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(home, 'tokens.env'), tokensEnv, 'utf8');
  copyFileSync(join(REPO, 'config', 'models.yml'), join(configDir, 'models.yml'));
}

/**
 * 跑一次探针。
 *
 * **必须是异步 spawn**：本测试进程同时是假网关 —— `spawnSync` 会把事件循环按住，
 * 网关永远 accept 不到、更答不出，子进程只能等到自己的 60s 总超时。第一版就是
 * 这么写的，现象是"两条测试各挂 60 秒"，看着像探针有 bug，其实是测试自己堵住了自己。
 */
function runProbe(env: Record<string, string>, home: string, configDir: string): Promise<{
  status: number | null;
  text: string;
}> {
  const childEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => typeof v === 'string' && !k.includes('API_KEY')),
    ),
    // 清掉可能从开发机继承的 key，否则"文件里有"这条就测不到。
    HY3_API_KEY: '',
    OPENROUTER_API_KEY: '',
    BACKUP_API_KEY: '',
    CHARLIE_HOME: home,
    // `layeredEnv` 除了 `<home>/tokens.env`，还会兜底看 `~/.dotd/tokens.env`
    // （老部署形态）。开发机上那份是真的、且真有 key —— 不把 homedir 也指到临时目录，
    // 所有测试都会意外"从文件里找到 key"，测的东西就不成立了。
    HOME: home,
    USERPROFILE: home,
    DOTD_CONFIG_DIR: configDir,
    DOTD_MODEL_HOST: `http://127.0.0.1:${PORT}`,
    ...env,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'scripts', 'probe-live-model.mjs')], {
      cwd: REPO,
      env: childEnv,
    });
    let buf = '';
    const cap = (d: Buffer): void => {
      buf += d.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, text: buf });
    });
  });
}

describe('① 顺序：shell 里有就用 shell 的', () => {
  let server: Server;
  let seen: string[];
  let home: string;
  let configDir: string;

  before(async () => {
    ({ server, seen } = await startFakeGateway('shell-wins'));
    home = mkdtempSync(join(tmpdir(), 'dotd-probe-shell-'));
    configDir = mkdtempSync(join(tmpdir(), 'dotd-probe-cfg-'));
    makeWorld(`export HY3_API_KEY=${KEY}\n`, home, configDir);
  });

  after(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('shell 的 key 盖过 tokens.env 里的旧值', async () => {
    const r = await runProbe({ HY3_API_KEY: 'shell-wins' }, home, configDir);
    const text = r.text;
    assert.equal(r.status, 0, text);
    assert.match(text, /凭据来源\s+当前 shell 的环境变量/);
    assert.equal(seen.at(-1), 'Bearer shell-wins', '网关收到的必须是 shell 那一个，不是文件里的');
    assert.doesNotMatch(text, new RegExp(KEY), '文件里的旧值不该被使用，更不该被打印');
  });
});

describe('② 落地：文件里找到的 key 要真的被 transport 用上', () => {
  let server: Server;
  let seen: string[];
  let home: string;
  let configDir: string;

  before(async () => {
    ({ server, seen } = await startFakeGateway(KEY));
    home = mkdtempSync(join(tmpdir(), 'dotd-probe-file-'));
    configDir = mkdtempSync(join(tmpdir(), 'dotd-probe-cfg2-'));
    makeWorld(`export HY3_API_KEY=${KEY}\n`, home, configDir);
  });

  after(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('shell 没有、tokens.env 有 → 往返成功，且网关收到 Bearer 该值', async () => {
    const r = await runProbe({}, home, configDir);
    const text = r.text;
    assert.equal(r.status, 0, text);
    assert.match(text, /凭据来源\s+.*tokens\.env/);
    assert.equal(
      seen.at(-1),
      `Bearer ${KEY}`,
      'apiKeyFor() 只读 process.env：脚本不把找到的 key 写回去，这里就会是 undefined',
    );
    assert.match(text, /connect:\s+成功/);
    assert.match(text, /tool_calls: 是/);
    assert.match(text, /已还原为契约名/, 'fs_read 要被还原回 fs.read');
  });

  test('key 的值一个字符都不许出现在输出里', async () => {
    const r = await runProbe({}, home, configDir);
    const text = r.text;
    assert.doesNotMatch(text, new RegExp(KEY), `泄露了：${KEY.slice(0, 8)}…`);
    assert.match(text, /值不打印/, '来源那一行要明说没打印值');
  });
});

describe('③ 三处都没有 → 说"未验证"，并列出查过哪三处', () => {
  let home: string;
  let configDir: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'dotd-probe-none-'));
    configDir = mkdtempSync(join(tmpdir(), 'dotd-probe-cfg3-'));
    makeWorld('', home, configDir);
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('exit 0（未验证不算失败），提示含三处来源与"未验证"措辞', async () => {
    const r = await runProbe({}, home, configDir);
    const text = r.text;
    assert.equal(r.status, 0, text);
    assert.match(text, /connect:\s+未验证/);
    assert.match(text, /当前 shell 环境变量/);
    assert.match(text, /tokens\.env/);
    assert.match(text, /运行中 daemon 的进程环境/);
    assert.match(text, /"未验证"，不是"不可用"/);
  });
});
