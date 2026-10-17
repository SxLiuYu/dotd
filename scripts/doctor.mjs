#!/usr/bin/env node
/**
 * scripts/doctor.mjs —— `npm run doctor`：上线前体检。
 *
 * 为什么要有它：README「已知限制」里最贵的一类坑都是**静默失败**——
 *   - `DOTD_FLEET=Docker`（大小写错）或 `docker`（想开真容器但拼错）会**静默回落 stub**，
 *     daemon 正常起、任务正常跑完，只是所有工具执行都是假的（src/exec/types.ts 的
 *     execConfigFromEnv 只认精确的 'stub'/'docker'）。
 *   - `DOTD_MODEL_TRANSPORT` 未设 = **真实 HTTP**（与 DOTD_FLEET 的缺省正好相反）。
 *   - tier1 的 key 只存在于启动它的那个 shell 里，daemon 重启即 tier1 全灭，
 *     现象是"daemon 正常起、所有交互任务挂起"。
 *   - 字面量 `${VAR}` 没展开、路径写错、DB 版本落后——全都是"看起来跑起来了"。
 *
 * 设计原则：
 *   1. **只读**。不写配置、不改库、不起容器、不发模型请求（连续性探测只做 TCP 连接）。
 *   2. 每一项都给「人话结论 + 下一步命令」，而不是抛异常。
 *   3. 退出码：0 = 全部通过或只有 warn；1 = 有 fail（照这份配置起 daemon 会出问题）。
 *
 * 用法：
 *   npm run doctor
 *   node scripts/doctor.mjs            # 同上
 *   node scripts/doctor.mjs --json     # 机器可读（CI / 诊断脚本用）
 *
 * cwd 无关：一切仓库内路径从本文件位置推导。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const MIN_NODE_MAJOR = 24;

/** 结果档位：ok / warn / fail / skip。fail 才会让退出码变 1。 */
export const STATUS = Object.freeze({ OK: 'ok', WARN: 'warn', FAIL: 'fail', SKIP: 'skip' });

/**
 * **严格展开**的环境变量（缺席即 ConfigError 拒启动）。
 * 出处：src/surfaces/config.ts 的 expandEnv 调用点——master_token / readonly_tokens /
 * hooks[].secret 三处走 strict:true；memory 展开恒严格。
 * 其余（TG_BOT_TOKEN、FEISHU_* 六字段等）是 strict:false，未设置 → 空串 → daemon 照常起。
 * 这张表就是 doctor 判"缺 key 会拒启动"的唯一依据，**与实现同源**，不要凭印象加项。
 */
export const STRICT_ENV_KEYS = Object.freeze(
  new Set(['DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'HOOK_GRAFANA', 'DOTD_DB_PATH']),
);

/**
 * 体检项清单（导出给 tests/scripts-doctor.test.ts 做结构断言：
 * 名字/顺序/必查项都是契约的一部分，删一项就该有测试红）。
 */
export const CHECKS = Object.freeze([
  'node',
  'repo',
  'surfaces-config',
  'placeholders',
  'fleet',
  'model-transport',
  'tier1-endpoint',
  'tier1-key',
  'db',
  'home-dir',
]);

// ── 工具 ────────────────────────────────────────────────────────────────

/**
 * 把 `DOTD_FLEET` 的原始值判成"实际生效值"。
 *
 * 与 src/exec/types.ts 的 `execConfigFromEnv` 必须**逐字同义**：
 * 只有精确等于 'stub' / 'docker' 才覆盖，其余（含未设）一律回落 'stub'。
 * 刻意拼成一个纯函数，好让测试直接把真值表跑一遍。
 */
export function resolveFleet(raw) {
  const v = raw === undefined || raw === null ? '' : String(raw);
  if (v === 'stub') return { effective: 'stub', raw: v, warn: null };
  if (v === 'docker') return { effective: 'docker', raw: v, warn: null };
  if (v === '') {
    return {
      effective: 'stub',
      raw: '',
      warn:
        'DOTD_FLEET 未设置 → 实际生效 stub（不起容器）。想跑真容器必须显式设 DOTD_FLEET=docker。' +
        '这是本项目最容易误解的一处：模型传输的缺省是"真"，fleet 的缺省是"假"。',
    };
  }
  return {
    effective: 'stub',
    raw: v,
    warn:
      `DOTD_FLEET='${v}' 不是精确的 'stub'/'docker'，已被**静默忽略**并回落 stub。` +
      '拼写（大小写）错了就白配了：改成 DOTD_FLEET=docker 并重启。',
  };
}

/** 同理：`DOTD_MODEL_TRANSPORT` 只有 'stub' 走内存 stub，其余（含未设）= 真实 HTTP。 */
export function resolveModelTransport(raw) {
  const v = raw === undefined || raw === null ? '' : String(raw);
  if (v === 'stub') return { effective: 'stub', raw: v };
  return { effective: 'real-http', raw: v };
}

/** 从极简 YAML 文本里抠出 tier1 端点（不引第三方 YAML：doctor 必须零依赖可跑）。 */
export function parseTier1Endpoint(text) {
  const lines = String(text).split(/\r?\n/);
  let inEndpoints = false;
  let cur = null;
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (/^endpoints:\s*$/.test(line)) {
      inEndpoints = true;
      continue;
    }
    if (inEndpoints && /^\S/.test(line)) break; // 顶层键结束 endpoints 段
    if (!inEndpoints) continue;
    const idM = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idM !== null) {
      if (cur !== null) out.push(cur);
      cur = { id: idM[1], tier: null, baseUrl: null, apiKeyEnv: null, enabled: true, primaryModel: null };
      continue;
    }
    if (cur === null) continue;
    const kv = (k) => {
      const m = new RegExp(`^\\s+${k}:\\s*(.+?)\\s*$`).exec(line);
      return m === null ? null : m[1];
    };
    const tier = kv('tier');
    if (tier !== null) cur.tier = Number(tier);
    const burl = kv('base_url');
    if (burl !== null) cur.baseUrl = burl;
    const keyEnv = kv('api_key_env');
    if (keyEnv !== null) cur.apiKeyEnv = keyEnv;
    const en = kv('enabled');
    if (en !== null) cur.enabled = en !== 'false';
    const prim = /^\s+primary:\s*(\S+)\s*$/.exec(line);
    if (prim !== null && cur.primaryModel === null) cur.primaryModel = prim[1];
  }
  if (cur !== null) out.push(cur);
  return out.filter((e) => e.tier === 1);
}

/** 默认值写法的占位符（`${VAR:-default}`）在变量缺席时用的默认值。 */
export function expandWithDefault(value, env) {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/.exec(String(value).trim());
  if (m === null) return { value, resolved: true };
  const name = m[1];
  const fallback = m[2];
  const actual = env[name];
  if (actual !== undefined && actual !== '') return { value: actual, resolved: true };
  if (fallback !== undefined) return { value: fallback, resolved: true };
  return { value: '', resolved: false, missing: name };
}

/** TCP 连通性探测（不握手、不发请求）：连上即通。 */
function probeTcp(host, port, timeoutMs = 1_500) {
  return new Promise((resolveProbe) => {
    const started = Date.now();
    const sock = connect({ host, port });
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolveProbe({ ok, detail, latencyMs: Date.now() - started });
    };
    sock.setTimeout(timeoutMs, () => done(false, `${timeoutMs}ms 内连不上`));
    sock.once('connect', () => done(true, 'TCP 可连'));
    sock.once('error', (e) => done(false, e.code ?? e.message));
  });
}

// ── 体检主体 ────────────────────────────────────────────────────────────

/**
 * 跑全部体检项。**纯只读**；依赖全部显式传入，便于测试。
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]  环境变量（缺省 process.env）
 * @param {string} [opts.home]                          用户 home（缺省 os.homedir()）
 * @param {string} [opts.repoRoot]                      仓库根
 * @param {(host:string, port:number, ms:number)=>Promise<{ok:boolean,detail:string,latencyMs:number}>} [opts.probe]
 * @returns {Promise<Array<{name:string,status:string,title:string,detail:string,next:string|null}>>}
 */
export async function runChecks(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const probe = opts.probe ?? probeTcp;
  const results = [];
  const add = (name, status, title, detail, next = null) => {
    results.push({ name, status, title, detail, next });
  };

  // 1. Node 版本（Node 24 的 node:sqlite / 原生 ESM 是硬要求，见 CONVENTIONS §1）
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    add('node', STATUS.OK, `Node v${process.versions.node}`, `满足 >= ${MIN_NODE_MAJOR}`);
  } else {
    add(
      'node',
      STATUS.FAIL,
      `Node v${process.versions.node} 太旧`,
      `本项目用内置 node:sqlite 与原生 ESM type-stripping，硬要求 >= ${MIN_NODE_MAJOR}`,
      '升级 Node 24（scripts/wsl-install-node24.sh 或 nodejs.org）后重跑',
    );
  }

  // 2. 仓库完整性：入口与模板是否都在（clone 不全时最常见的报错源）
  const required = [
    'package.json',
    'tsconfig.json',
    'src/daemon.ts',
    'src/surfaces/cli.ts',
    'config/dotd.yml',
    'config/models.yml',
    'db/migrations',
    'agent-runtime',
    'exec-image/Dockerfile',
  ];
  const missing = required.filter((p) => !existsSync(join(repoRoot, p)));
  if (missing.length === 0) {
    add('repo', STATUS.OK, '仓库文件齐全', `${required.length} 项必需路径都在`);
  } else {
    add(
      'repo',
      STATUS.FAIL,
      `仓库缺 ${missing.length} 项`,
      missing.join(', '),
      '重新 clone 或检查是否在子目录里跑（doctor 会自己推导仓库根，不用 cd）',
    );
  }

  // 3. surfaces 配置：daemon 只读 ~/.dotd/config.yml，仓库里的 config/dotd.yml 只是模板
  const cfgPath = env.DOTD_CONFIG !== undefined && env.DOTD_CONFIG !== ''
    ? env.DOTD_CONFIG
    : join(home, '.dotd', 'config.yml');
  let cfgText = '';
  if (!existsSync(cfgPath)) {
    add(
      'surfaces-config',
      STATUS.FAIL,
      `读不到 ${cfgPath}`,
      'daemon 只从这份文件读 surfaces 七节；仓库里的 config/dotd.yml 是模板，不会被自动加载',
      'npm run init-config（幂等，不会覆盖已有的真 token）',
    );
  } else {
    cfgText = readFileSync(cfgPath, 'utf8');
    add('surfaces-config', STATUS.OK, `${cfgPath}`, `${cfgText.length} 字节，存在`);
  }

  // 4. 占位符展开：master_token 这类走严格展开，未设置即 ConfigError 拒启动
  if (cfgText !== '') {
    // 只看**没有默认值**的占位符：`${VAR:-默认}` 在变量缺席时会用默认值，不算缺。
    // 另外被整行 `#` 注释掉的说明文字不算（init-config 生成的配置里带注释块，
    // 注释里常出现 `${VAR}` 作为示例，数进来会误报）。
    // 非严格展开的键（tg_text / feishu 六字段 / data_dir 一类）**未设置是合法的**：
    // src/surfaces/config.ts 里它们用 strict:false，缺席即空串，daemon 照常启动。
    // 所以判"缺"要两个条件同时成立：没有默认值 **且** 在严格展开清单里。
    const codeLines = cfgText
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const placeholders = [...codeLines.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)];
    const strict = placeholders.filter((m) => m[2] === undefined && STRICT_ENV_KEYS.has(m[1]));
    const unset = strict.filter((m) => env[m[1]] === undefined || env[m[1]] === '').map((m) => m[1]);
    const uniqueUnset = [...new Set(unset)];
    if (uniqueUnset.length === 0) {
      add(
        'placeholders',
        STATUS.OK,
        '配置里的严格占位符都能展开',
        `共 ${placeholders.length} 处占位符，其中 ${strict.length} 处严格（无默认值且不可缺省）`,
      );
    } else {
      add(
        'placeholders',
        STATUS.FAIL,
        `${uniqueUnset.length} 个严格占位符在环境里没有值`,
        uniqueUnset.join(', '),
        `先 source ~/.dotd/tokens.env（PowerShell：dot-sourcing 后手动 export 到当前会话），再 npm run serve`,
      );
    }
  } else {
    add('placeholders', STATUS.SKIP, '跳过占位符检查', '没有可读的 config.yml');
  }

  // 5. DOTD_FLEET：最容易静默出错的一项
  const fleet = resolveFleet(env.DOTD_FLEET);
  if (fleet.warn === null) {
    add('fleet', STATUS.OK, `DOTD_FLEET=${fleet.raw} → ${fleet.effective}`, fleet.effective === 'docker' ? '真容器路径（需要 docker daemon 可达）' : '不起容器');
  } else {
    add('fleet', STATUS.WARN, 'DOTD_FLEET 实际生效值让人意外', fleet.warn, 'export DOTD_FLEET=docker（或明确留空表示就用 stub）后再起 daemon');
  }

  // 6. DOTD_MODEL_TRANSPORT：缺省是"真 HTTP"，与 fleet 相反
  const mt = resolveModelTransport(env.DOTD_MODEL_TRANSPORT);
  add(
    'model-transport',
    STATUS.OK,
    `DOTD_MODEL_TRANSPORT=${mt.raw === '' ? '（未设）' : mt.raw} → ${mt.effective}`,
    mt.effective === 'stub' ? '模型走内存 stub，零网络请求（门禁/演示用）' : '真 HTTP（会打 config/models.yml 里的端点）',
  );

  // 7/8. tier1 端点：这是唯一能承载 primary 轨的端点，断了所有交互任务都挂起
  let tier1 = null;
  const modelsPath = join(repoRoot, 'config', 'models.yml');
  if (existsSync(modelsPath)) {
    const endpoints = parseTier1Endpoint(readFileSync(modelsPath, 'utf8'));
    tier1 = endpoints.find((e) => e.enabled) ?? endpoints[0] ?? null;
  }
  if (tier1 === null || tier1.baseUrl === null) {
    add('tier1-endpoint', STATUS.FAIL, 'config/models.yml 里没有可用的 tier1 端点', 'primary 轨无处可去，所有交互任务都会挂起', '检查 config/models.yml 的 endpoints[].tier: 1');
  } else {
    const expanded = expandWithDefault(tier1.baseUrl, env);
    if (!expanded.resolved) {
      add('tier1-endpoint', STATUS.FAIL, `tier1 base_url 的占位符 ${expanded.missing} 没有值`, tier1.baseUrl, `export ${expanded.missing}=...`);
    } else {
      let url = null;
      try {
        url = new URL(expanded.value);
      } catch {
        url = null;
      }
      if (url === null) {
        add('tier1-endpoint', STATUS.FAIL, `tier1 base_url 不是合法 URL：${expanded.value}`, '解析失败', '改成 http(s)://host:port/v1 形式');
      } else {
        const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
        const host = url.hostname;
        const r = await probe(host, port, 1_500);
        if (r.ok) {
          add('tier1-endpoint', STATUS.OK, `${tier1.id} ${expanded.value}`, `${r.detail}（${r.latencyMs}ms）`);
        } else {
          add(
            'tier1-endpoint',
            STATUS.FAIL,
            `${tier1.id} 连不上 ${host}:${port}`,
            r.detail,
            '先把网关起起来（docs/tier1-endpoint.md 有搭建步骤），或改 config/models.yml 换端点',
          );
        }
      }
    }

    // 8. key：有端点却没凭据 = 每次请求都失败、计入熔断，现象是"daemon 正常起、任务全不干活"
    const keyEnv = tier1.apiKeyEnv;
    if (keyEnv === null || keyEnv === undefined) {
      add('tier1-key', STATUS.OK, 'tier1 端点未声明 api_key_env', '免 key 端点（本地引擎）');
    } else if (env[keyEnv] !== undefined && env[keyEnv] !== '') {
      add('tier1-key', STATUS.OK, `${keyEnv} 已设置`, `长度 ${String(env[keyEnv]).length}（值不打印）`);
    } else {
      add(
        'tier1-key',
        STATUS.FAIL,
        `环境里没有 ${keyEnv}`,
        '缺 key 不是启动期错误，但运行期请求会失败并计入熔断；tier1 是唯一能承载 primary 的端点',
        `把 export ${keyEnv}=... 写进 ~/.dotd/tokens.env，这样 daemon 重启后不会丢`,
      );
    }
  }

  // 9. 数据库：迁移版本是否跟上（落后 → daemon 拒启动；这是 fail-closed，但报错很难懂）
  const dbPath = env.DOTD_DB_PATH !== undefined && env.DOTD_DB_PATH !== ''
    ? env.DOTD_DB_PATH
    : join(home, '.dotd', 'dotd.db');
  if (!existsSync(dbPath)) {
    add('db', STATUS.WARN, `库文件还不存在：${dbPath}`, '首次启动会自动建库并迁移', '直接 npm run serve 即可');
  } else {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('PRAGMA user_version').get();
      db.close();
      const version = row?.user_version ?? 0;
      const expected = expectedUserVersion(repoRoot);
      if (expected === null) {
        add('db', STATUS.WARN, `user_version=${version}`, '算不出期望版本（db/migrations 缺失？）');
      } else if (version === expected) {
        add('db', STATUS.OK, `user_version=${version}`, `与 db/migrations 最高版本一致（${expected}）`);
      } else {
        add(
          'db',
          STATUS.WARN,
          `user_version=${version}，期望 ${expected}`,
          version < expected ? '落后：daemon 启动时会自动迁移（会先写 OUTBOX）' : '超前：这份代码比库旧',
          version < expected ? '直接 npm run serve 触发迁移' : '更新代码，或换回旧库',
        );
      }
    } catch (e) {
      add('db', STATUS.WARN, `读库失败：${dbPath}`, e instanceof Error ? e.message : String(e), '确认没有别的 daemon 正占着这个库');
    }
  }

  // 10. 数据目录可写性（不写，只看权限位/存在性）
  const dotdHome = env.DOTD_HOME !== undefined && env.DOTD_HOME !== '' ? env.DOTD_HOME : join(home, '.dotd');
  if (existsSync(dotdHome)) {
    add('home-dir', STATUS.OK, dotdHome, '数据目录存在（OUTBOX/journal-blobs/tokens 都在这下面）');
  } else {
    add('home-dir', STATUS.WARN, `${dotdHome} 还不存在`, '首次启动会创建', 'npm run serve');
  }

  return results;
}

/** 从 db/migrations 的 NNN_ 前缀算期望 user_version；目录缺失返回 null。 */
export function expectedUserVersion(repoRoot) {
  const dir = join(repoRoot, 'db', 'migrations');
  if (!existsSync(dir)) return null;
  const nums = [];
  for (const f of readdirSyncSafe(dir)) {
    const m = /^(\d{3})_.*\.sql$/.exec(f);
    if (m !== null) nums.push(Number(m[1]));
  }
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── 呈现 ────────────────────────────────────────────────────────────────

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };

export function formatReport(results) {
  const lines = ['dotd doctor —— 上线前体检（只读，不改任何东西）', ''];
  for (const r of results) {
    lines.push(`${ICON[r.status] ?? '  '} ${r.title}`);
    if (r.detail !== '' && r.detail !== null) lines.push(`     ${r.detail}`);
    if (r.next !== null && r.next !== undefined) lines.push(`     → 下一步：${r.next}`);
  }
  const fail = results.filter((r) => r.status === STATUS.FAIL).length;
  const warn = results.filter((r) => r.status === STATUS.WARN).length;
  lines.push('');
  lines.push(
    fail === 0
      ? `结论：${results.length} 项检查，0 项阻止启动${warn > 0 ? `，${warn} 项警告（能起，但行为可能不是你以为的那样）` : ''}。`
      : `结论：${fail} 项会让 daemon 起不来或干了假活，先按上面的「下一步」修。`,
  );
  return lines.join('\n');
}

/** 是否应当以非零退出（CI 用）。只有 fail 才算。 */
export function exitCodeFor(results) {
  return results.some((r) => r.status === STATUS.FAIL) ? 1 : 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────

const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const norm = (p) => {
    try {
      return resolve(p).replace(/\\/g, '/').toLowerCase();
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(fileURLToPath(import.meta.url));
})();

if (isMain) {
  const json = process.argv.includes('--json');
  runChecks()
    .then((results) => {
      if (json) process.stdout.write(`${JSON.stringify({ results, exitCode: exitCodeFor(results) }, null, 2)}\n`);
      else process.stdout.write(`${formatReport(results)}\n`);
      process.exitCode = exitCodeFor(results);
    })
    .catch((e) => {
      process.stderr.write(`doctor 自身出错：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exitCode = 2;
    });
}

