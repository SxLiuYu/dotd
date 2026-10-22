#!/usr/bin/env bash
# scripts/regress/web-console-criteria.sh —— F6 验收判据：Web 控制台离开 localhost
#
# ## 为什么需要它
# 本轮把监听地址从写死的 127.0.0.1 变成可配置（surfaces.http.host / DOTD_HTTP_HOST）。
# 可配置的东西一定有人改，而改错的方向是**往外改**，往外改的代价是静默的：master
# token 就是这台机器的全权凭据，端口一旦落到局域网，凭据从「本机」降级为「同网段」，
# 而且没人会在日志里看到「我把门打开了」这行字。
#
# ## 守什么
#   ① 代码默认值必须仍是 127.0.0.1 —— 升级 daemon 不能自己开始对外（§① §②）；
#   ② 真把非回环打开时，鉴权边界只能收紧、不能放宽，且当场留下可核对的证据（§④⑤⑥）；
#   ③ 手机能用 + PWA 最小集 + 构建/既有测试没被打破（§⑦⑧⑨）。
#
# 参照 progress-criteria.sh 的写法：判据守**代码默认值**（DEFAULT_HTTP_HOST /
# zod .default(DEFAULT_HTTP_HOST)），**不守部署配置值**。config/dotd.yml 里那行 host
# 是主人当下的选择，本轮不做判据（只在 §③ 打印出来供人核对）—— 否则主人哪天
# 有理由地换绑，判据就红一条不相干的。
#
# 用法：bash scripts/regress/web-console-criteria.sh   （约 20s）
# 纪律：**不碰生产 :7788、不重启 daemon**。§⑥ 的真监听用「临时端口 + 独立进程」，
#       配置走脚本自己的临时 ts，不改 config/dotd.yml；产物用完即删。
set -u
cd "$(dirname "$0")/../.." || exit 2
PASS=0
FAIL=0
SKIP=0
t() {
  local out
  if out=$(eval "$1" 2>&1); then
    PASS=$((PASS + 1)); echo "  PASS $2"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL $2"; echo "$out" | head -6 | sed 's/^/       /'
  fi
}
skip() { SKIP=$((SKIP + 1)); echo "  SKIP $1"; }

echo "① 代码默认值 = 回环（本轮最重要的不变量）"
t "grep -q \"^export const DEFAULT_HTTP_HOST = '127.0.0.1';\" src/surfaces/config.ts" \
  "DEFAULT_HTTP_HOST 的字面量就是 127.0.0.1"
t "grep -q 'host: z.string().min(1).default(DEFAULT_HTTP_HOST)' src/surfaces/config.ts" \
  "zod 的默认值引用那个常量（不是两处各写一份、日后各改各的）"
t "! grep -qE \"host: z\\.string\\(\\)\\.min\\(1\\)\\.default\\('(0\\.0\\.0\\.0|::|localhost|0\\.0\\.0\\.1)\" src/surfaces/config.ts" \
  "没人把默认值偷偷换成 0.0.0.0 / :: 之类"
t "grep -q 'host: resolveHttpHost(s.http.host)' src/surfaces/config.ts" \
  "surfaces 节映射真的走了 resolveHttpHost（否则环境变量覆盖是死代码）"

echo "② 解析与回环判定的真实行为（跑代码，不是 grep 注释）"
cat > .f6-bind.ts <<'NODE'
import assert from 'node:assert/strict';
import { DEFAULT_HTTP_HOST, HTTP_HOST_ENV, resolveHttpHost, isLoopbackBindHost } from './src/surfaces/config.ts';
const checks: string[] = [];
const ok = (name: string, fn: () => void): void => {
  try { fn(); checks.push(name); }
  catch (e) { console.log('BAD ' + name + ' :: ' + String(e).slice(0, 200)); process.exit(1); }
};
ok('常量 = 127.0.0.1', () => assert.equal(DEFAULT_HTTP_HOST, '127.0.0.1'));
ok('环境变量名 = DOTD_HTTP_HOST', () => assert.equal(HTTP_HOST_ENV, 'DOTD_HTTP_HOST'));
ok('无配置无环境 => 回环', () => assert.equal(resolveHttpHost(undefined, {}), '127.0.0.1'));
ok('配置空串 => 回环（fail-closed，绝不回落 0.0.0.0）', () => assert.equal(resolveHttpHost('', {}), '127.0.0.1'));
ok('配置只有空白 => 回环', () => assert.equal(resolveHttpHost('   ', {}), '127.0.0.1'));
ok('未设置的 ${占位符} => 回环（非严格展开，不因未设置拒启动）',
  () => assert.equal(resolveHttpHost('${DOTD_UNSET_FOR_SURE_XYZ}', {}), '127.0.0.1'));
ok('配置照写 => 用配置', () => assert.equal(resolveHttpHost('10.0.0.5', {}), '10.0.0.5'));
ok('环境变量优先于配置', () => assert.equal(resolveHttpHost('10.0.0.5', { [HTTP_HOST_ENV]: '172.17.59.108' }), '172.17.59.108'));
ok('环境变量为空串 => 回落到配置（不是回落到 0.0.0.0）', () => assert.equal(resolveHttpHost('10.0.0.5', { [HTTP_HOST_ENV]: '  ' }), '10.0.0.5'));
ok('0.0.0.0 显式写出来 => 照用（可配置不等于禁止扩面）', () => assert.equal(resolveHttpHost('0.0.0.0', {}), '0.0.0.0'));
for (const h of ['127.0.0.1', '127.9.9.9', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
  ok('回环 true: ' + h, () => assert.equal(isLoopbackBindHost(h), true));
}
// 这一组是 F6 最容易搞错的一条：0.0.0.0 / :: 看着像占位符，实际是「所有网卡」。
for (const h of ['0.0.0.0', '::', '*', '172.17.59.108', '10.0.0.5', '', '  ', 'localhost.evil']) {
  ok('回环 false: ' + JSON.stringify(h), () => assert.equal(isLoopbackBindHost(h), false));
}
console.log('OK ' + checks.length + ' checks');
NODE
t "node --import tsx .f6-bind.ts 2>&1 | grep -q '^OK '" "resolveHttpHost / isLoopbackBindHost 的行为全表对（项数见脚本自己的 OK 输出）"
rm -f .f6-bind.ts

echo "③ 部署配置现状（只打印，不判定 —— 主人的选择不是判据）"
HOST_LINE=$(grep -nE '^[[:space:]]*host:' config/dotd.yml | head -1)
echo "       config/dotd.yml -> ${HOST_LINE:-（没有 host 行，即走代码默认值）}"
echo "       注：这里不是 127.0.0.1 也算正常（主人有意对外）；代码默认值由 §① §② 守"
t "grep -q 'DOTD_HTTP_HOST' config/dotd.yml"       "配置模板写清了环境变量覆盖这条路"
t "grep -q '拒启动' config/dotd.yml"                "配置模板写清了「非回环 + 白名单不显式 = 拒启动」"
t "grep -q '回环对端' config/dotd.yml"              "配置模板写清了保险库写路径的回环门控"

echo "④ 非回环时 Origin 白名单不许「没写 / 通配」；鉴权只收紧不放宽"
cat > .f6-origins.ts <<'NODE'
import assert from 'node:assert/strict';
import { assertHttpConfig, originsAreLenient, originAllowedForBind, routeRequiresLoopbackPeer, isLoopbackPeer } from './src/surfaces/http.ts';
import { ConfigError } from './src/shared/errors.ts';
import type { SurfacesConfig } from './src/surfaces/types.ts';

const base = (http: Partial<SurfacesConfig['http']>): SurfacesConfig => ({
  http: { host: '127.0.0.1', port: 7788, masterToken: 'm', readonlyTokens: [], allowedOrigins: [], ...http },
  hooks: [], jsonlWatch: [], heartbeat: { tickIntervalS: 15 },
  telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
  feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
  ui: { streamDeltas: true }, progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
});
const checks: string[] = [];
const ok = (name: string, fn: () => void): void => {
  try { fn(); checks.push(name); }
  catch (e) { console.log('BAD ' + name + ' :: ' + String(e).slice(0, 200)); process.exit(1); }
};

// 回环侧行为必须与改造前逐字一致（否则本轮把自己人拦在门外）
ok('回环 + 空白名单：任意 Origin 照放（既有行为不变）',
  () => assert.equal(originAllowedForBind({ origin: 'http://evil.example' }, [], true), true));
// 非回环 + 空白名单 = 未显式授权 => 带浏览器来源一律拒；无来源客户端不受影响
ok('非回环 + 空白名单：带 Origin 拒', () => assert.equal(originAllowedForBind({ origin: 'http://evil.example' }, [], false), false));
ok('非回环 + 空白名单：带 Referer 拒', () => assert.equal(originAllowedForBind({ referer: 'http://evil.example/x' }, [], false), false));
ok('非回环 + 空白名单：curl/CLI（无来源）放行', () => assert.equal(originAllowedForBind({}, [], false), true));
// 通配意图同样算未授权（现 matcher 其实不认 *，写了等于没写 -> 网页全 403）
ok('非回环 + 含 * 的白名单：按未授权处理',
  () => assert.equal(originAllowedForBind({ origin: 'http://10.0.0.5:7788' }, ['http://10.0.0.5:7788', '*'], false), false));
ok('originsAreLenient 认得出空/通配/空白串', () => {
  assert.equal(originsAreLenient([]), true);
  assert.equal(originsAreLenient(['*']), true);
  assert.equal(originsAreLenient(['  ']), true);
  assert.equal(originsAreLenient(['http://a']), false);
});
ok('非回环 + 显式白名单：命中放、不命中拒（精确匹配）', () => {
  assert.equal(originAllowedForBind({ origin: 'http://10.0.0.5:7788' }, ['http://10.0.0.5:7788'], false), true);
  assert.equal(originAllowedForBind({ origin: 'http://evil.example' }, ['http://10.0.0.5:7788'], false), false);
});
// assertHttpConfig：非回环 + 空/通配 => ConfigError 拒启动（GOV §2.3 口径）
ok('拒启动：非回环 + 空白名单', () => assert.throws(() => assertHttpConfig(base({ host: '10.0.0.5', allowedOrigins: [] })), ConfigError));
ok('拒启动：非回环 + 通配', () => assert.throws(() => assertHttpConfig(base({ host: '10.0.0.5', allowedOrigins: ['*'] })), ConfigError));
ok('拒启动：0.0.0.0 也算非回环', () => assert.throws(() => assertHttpConfig(base({ host: '0.0.0.0', allowedOrigins: [] })), ConfigError));
ok('不拒：回环 + 空白名单（既有部署与既有测试的前提）', () => assertHttpConfig(base({ host: '127.0.0.1', allowedOrigins: [] })));
ok('不拒：非回环 + 显式白名单', () => assertHttpConfig(base({ host: '10.0.0.5', allowedOrigins: ['http://10.0.0.5:7788'] })));
ok('不拒：master_token 为空的检查仍在（没被新逻辑盖掉）',
  () => assert.throws(() => assertHttpConfig(base({ host: '127.0.0.1', masterToken: '' })), ConfigError));
// 保险库写路径：只有扩面后才生效，读路径不动
ok('保险库写路径门控只覆盖 put/delete', () => {
  assert.equal(routeRequiresLoopbackPeer('vault_put'), true);
  assert.equal(routeRequiresLoopbackPeer('vault_delete'), true);
  assert.equal(routeRequiresLoopbackPeer('vault_list'), false);
  assert.equal(routeRequiresLoopbackPeer('messages'), false);
});
// 回环对端判定只认 socket：X-Forwarded-For 是客户端可编的
ok('isLoopbackPeer 只看 socket.remoteAddress', () => {
  const mk = (a: string) => ({ socket: { remoteAddress: a }, headers: { 'x-forwarded-for': '8.8.8.8' } }) as never;
  assert.equal(isLoopbackPeer(mk('127.0.0.1')), true);
  assert.equal(isLoopbackPeer(mk('::1')), true);
  assert.equal(isLoopbackPeer(mk('::ffff:127.0.0.1')), true);
  assert.equal(isLoopbackPeer(mk('10.0.0.9')), false);
  assert.equal(isLoopbackPeer(mk('2001:db8::1')), false);
});
console.log('OK ' + checks.length + ' checks');
NODE
t "node --import tsx .f6-origins.ts 2>&1 | grep -q '^OK '" "Origin 闸 / 拒启动 / 保险库门控行为全对"
rm -f .f6-origins.ts

echo "⑤ 非回环启动必须留话（告警不可静默，也不许刷屏）"
cat > .f6-warn.ts <<'NODE'
import { assertHttpConfig } from './src/surfaces/http.ts';
import type { SurfacesConfig } from './src/surfaces/types.ts';
const cfg = (host: string, allowedOrigins: string[]): SurfacesConfig => ({
  http: { host, port: 18777, masterToken: 'm', readonlyTokens: [], allowedOrigins },
  hooks: [], jsonlWatch: [], heartbeat: { tickIntervalS: 15 },
  telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
  feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
  ui: { streamDeltas: true }, progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
});
const got: string[] = [];
const orig = process.emitWarning;
process.emitWarning = ((w: string | Error) => { got.push(String(typeof w === 'string' ? w : w.message)); }) as typeof process.emitWarning;
try {
  // 非回环 + 白名单写了但不指向这个 bind 地址 => 告警（不抛）：「网页全 403」陷阱
  assertHttpConfig(cfg('10.0.0.5', ['http://localhost:18777']));
  // 同 host:port 再来一次 => 去重必须生效，否则日志被同一条刷两遍
  assertHttpConfig(cfg('10.0.0.5', ['http://localhost:18777']));
} finally {
  process.emitWarning = orig;
}
const text = got.join('\n');
const bad: string[] = [];
if (!/非回环/.test(text)) bad.push('没出现「非回环」字样');
if (!/allowed_origins/.test(text)) bad.push('没点出 allowed_origins');
if (!/403/.test(text)) bad.push('没说清症状（浏览器会全 403）');
// 扩面要说两件事，各自一次：①「这是非回环监听」②「白名单没指向它 => 网页全 403」。
// 去重的单位是「一条消息」，不是「一次启动」——所以两条各数一次，重复即刷屏。
const count = (re: RegExp) => got.filter((g) => re.test(g)).length;
const nListen = count(/监听非回环地址|请确认这是主人的本意/);
const nOrigins = count(/allowed_origins 里没有一条指向它/);
if (nListen !== 1) bad.push('「非回环监听」告警重复了 ' + nListen + ' 次');
if (nOrigins !== 1) bad.push('「白名单对不上」告警重复了 ' + nOrigins + ' 次');
// 回环启动不该有任何对外告警
const g2: string[] = [];
const o2 = process.emitWarning;
process.emitWarning = ((w: string | Error) => { g2.push(String(w)); }) as typeof process.emitWarning;
try { assertHttpConfig(cfg('127.0.0.1', [])); } finally { process.emitWarning = o2; }
if (g2.some((g) => /非回环/.test(g))) bad.push('回环启动却告警了');
console.log(bad.length === 0 ? 'OK' : 'BAD ' + bad.join(' | '));
NODE
t "node --import tsx .f6-warn.ts 2>&1 | grep -qx 'OK'" "非回环 + 白名单没指向 bind => 恰好一条可操作的告警；回环无告警"
rm -f .f6-warn.ts

echo "⑥ 真起监听：非回环地址真的连得上、鉴权真的生效（临时端口 + 独立进程）"
# 这一节是 F6 的核心证据：**不是打桩，是真 listen**。
#   - 绑本机可路由 IPv4（不是 127.0.0.1），端口 port:0 让内核发临时端口，
#     绝不碰生产 :7788，也躲开 daemon 测试常用的 18904/18905；
#   - 用 dotd 自己的 startHttpServer（与 daemon 同一个装配函数）；
#   - 独立进程，用完即退，不碰在跑的 daemon，也不改 config/dotd.yml。
cat > .f6-listen.ts <<'NODE'
import os from 'node:os';
import { makeTempDataDir } from './tests/helpers.ts';
import { EventBus } from './src/shared/bus.ts';
import { SseBus } from './src/surfaces/sse.ts';
import { startHttpServer, describeBind } from './src/surfaces/http.ts';
import { isLoopbackBindHost } from './src/surfaces/config.ts';
import type { SurfacesConfig } from './src/surfaces/types.ts';
import type { ControlPlane, GovernancePort, MemoryPort, RouterPort } from './src/shared/contracts.ts';

function firstRoutableIPv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
const HOST = firstRoutableIPv4();
if (HOST === null || isLoopbackBindHost(HOST)) { console.log('NO_INTERFACE'); process.exit(0); }

const MASTER = 'f6-criteria-master-token';
const dir = makeTempDataDir();
const db = dir.db;
const bus = dir.bus;
const sse = new SseBus({ db, bus });
const cp = {
  getTask: () => null, getJournal: () => [], list: () => [], snapshot: () => ({}),
  submit: () => ({}), cancel: () => undefined, resume: () => undefined, getGuardStatus: () => ({}),
} as unknown as ControlPlane;
const gov: GovernancePort = { decide: () => Promise.resolve({ ok: true }), listPending: () => [], getApproval: () => Promise.resolve(null) };
const mem: MemoryPort = {
  openThread: () => Promise.resolve('th'), appendMessage: () => Promise.resolve({ id: 'm', seq: 1 }),
  listThreads: () => Promise.resolve([]), listMessages: () => Promise.resolve([]),
};
const router: RouterPort = { snapshot: () => ({ mode: 'normal', endpoints: [], tracks: [] }) as never };

const cfg: SurfacesConfig = {
  // 绑 0.0.0.0（同样是非回环）：这样同一条监听既能被回环对端（127.0.0.1）也能被
  // 非回环对端（本机可路由 IP）连上，保险库门控的两个方向才能一次跑齐证据。
  http: { host: '0.0.0.0', port: 0, masterToken: MASTER, readonlyTokens: [], allowedOrigins: ['http://' + HOST + ':7788'] },
  hooks: [], jsonlWatch: [], heartbeat: { tickIntervalS: 15 },
  telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
  feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
  ui: { streamDeltas: true }, progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
};
const server = await startHttpServer({ db, bus, cp, gov, mem, router, channels: null, sse, cfg, webRoot: 'web-ui/dist' });
const port = (server.address() as { port: number }).port;
const base = 'http://' + HOST + ':' + port;           // 非回环对端
const local = 'http://127.0.0.1:' + port;               // 回环对端（同一条监听）
const out: Record<string, string> = { bind: describeBind(cfg), host: HOST, port: String(port) };

const code = async (b: string, path: string, init?: RequestInit): Promise<string> => {
  try { return String((await fetch(b + path, init)).status); } catch { return 'ERR'; }
};
// 1) 免鉴权路由可达 = 真的连上了非回环端口
out.health = await code(base, '/api/health');
out.healthz = await code(base, '/api/healthz');
// 2) 受保护路由：无凭据 401 / Bearer master 200（扩面没放宽鉴权）
out.queue_noauth = await code(base, '/api/queue');
out.queue_master = await code(base, '/api/queue', { headers: { authorization: 'Bearer ' + MASTER } });
out.queue_bad = await code(base, '/api/queue', { headers: { authorization: 'Bearer nope' } });
// 3) Origin 闸在扩面后仍在（白名单只有 http://HOST:7788，两个都不许过）
out.origin_wrong = await code(base, '/api/queue', { headers: { authorization: 'Bearer ' + MASTER, origin: 'http://evil.example' } });
out.origin_unlisted_port = await code(base, '/api/queue', { headers: { authorization: 'Bearer ' + MASTER, origin: 'http://' + HOST } });
// 4) SSE：?token= 老通道仍在，Authorization 头是 F6 新增的第二通道；两者都要 200，
//    无凭据/错凭据仍 401（只加通道，不放宽判定）
out.stream_query = await code(base, '/api/stream?topics=queue&token=' + MASTER);
out.stream_header = await code(base, '/api/stream?topics=queue', { headers: { authorization: 'Bearer ' + MASTER } });
out.stream_none = await code(base, '/api/stream?topics=queue');
out.stream_bad = await code(base, '/api/stream?topics=queue&token=nope');
// 5) SSE 不许落中间缓存
try {
  const r = await fetch(base + '/api/stream?topics=queue&token=' + MASTER);
  out.stream_cache = r.headers.get('cache-control') ?? 'none';
  r.body?.cancel().catch(() => undefined);
} catch { out.stream_cache = 'ERR'; }
// 6) 保险库写路径（F6 新增的回环门控）—— 同一台机器、同一条监听、两个对端：
//    带 secret 明文的写请求，非回环对端必须 403，回环对端照旧放行（走到未装配的 501）。
const vaultBody = JSON.stringify({ site: 's', user: 'u', secret: 'x' });
out.vault_nonloopback_peer = await code(base, '/api/vault/entries', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + MASTER, 'content-type': 'application/json' },
  body: vaultBody,
});
out.vault_loopback_peer = await code(local, '/api/vault/entries', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + MASTER, 'content-type': 'application/json' },
  body: vaultBody,
});
// 读路径不受门控（两个对端都应 200）
out.vault_list_nonloopback = await code(base, '/api/vault', { headers: { authorization: 'Bearer ' + MASTER } });
console.log(JSON.stringify(out));
await new Promise<void>((res) => server.close(() => res()));
dir.cleanup();
NODE
LISTEN_OUT=$(node --import tsx .f6-listen.ts 2>&1)
rm -f .f6-listen.ts
if echo "$LISTEN_OUT" | grep -q NO_INTERFACE; then
  skip "本机没有可路由 IPv4 —— 真实非回环监听无法在此环境验证"
else
  R=$(printf '%s\n' "$LISTEN_OUT" | grep -E '^\{.*\}$' | tail -1)
  echo "       $R"
  g() { printf '%s' "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)['$1'];console.log(v===undefined?'missing':v)}catch(e){console.log('parsefail')}})" ; }
  t "[ \"$(g health)\" = '200' ]"                        "GET /api/health = 200（非回环地址真连上了）"
  t "[ \"$(g healthz)\" = '200' ]"                       "GET /api/healthz 别名同样可达"
  t "[ \"$(g queue_noauth)\" = '401' ]"                  "无 token 打 /api/queue = 401（扩面没放宽鉴权）"
  t "[ \"$(g queue_bad)\" = '401' ]"                     "错 token = 401"
  t "[ \"$(g queue_master)\" = '200' ]"                  "Bearer master = 200"
  t "[ \"$(g origin_wrong)\" = '403' ]"                  "白名单外 Origin = 403（DNS rebinding 防护仍在）"
  t "[ \"$(g origin_unlisted_port)\" = '403' ]"          "Origin 缺端口（≠ 白名单条目）同样 = 403（精确匹配）"
  t "[ \"$(g stream_query)\" = '200' ]"                  "SSE ?token= 老通道仍可用（没为安全砍功能）"
  t "[ \"$(g stream_header)\" = '200' ]"                 "SSE 可用 Authorization 头（token 不必进 URL）"
  t "[ \"$(g stream_none)\" = '401' ]"                   "SSE 无凭据 = 401"
  t "[ \"$(g stream_bad)\" = '401' ]"                    "SSE 错 token = 401"
  t "printf '%s' \"$(g stream_cache)\" | grep -q no-store" "SSE 响应带 no-store"
  t "[ \"$(g vault_nonloopback_peer)\" = '403' ]"         "保险库写（带 secret）：非回环对端 = 403（F6 门控真生效）"
  t "[ \"$(g vault_loopback_peer)\" != '403' ]"           "保险库写：回环对端未被门控（501=未装配 / 200 都算通过）"
  t "[ \"$(g vault_list_nonloopback)\" = '200' ]"         "保险库读（只有 site/user）：非回环对端仍可用（门控只掐写）"
  t "printf '%s' \"$(g bind)\" | grep -q '非回环'"        "describeBind 如实说出这是非回环监听"
  t "printf '%s' \"$(g host)\" | grep -qvE '^(127\\.|::1|localhost)'" "证据里的对端确实是非回环地址（不是自己骗自己）"
fi

echo "⑦ 前端：手机可用（390px）+ PWA 最小集"
t "test -f web-ui/public/manifest.json"                  "manifest 存在（web-ui/public/manifest.json）"
t "node -e \"JSON.parse(require('fs').readFileSync('web-ui/public/manifest.json','utf8'))\"" "manifest 是合法 JSON"
t "grep -q '\"display\": \"standalone\"' web-ui/public/manifest.json" "manifest display=standalone"
t "grep -q '\"start_url\": \"/\"' web-ui/public/manifest.json"         "manifest start_url = /"
t "grep -q 'theme_color' web-ui/public/manifest.json"                 "manifest 有 theme_color"
t "grep -q 'icons' web-ui/public/manifest.json"                       "manifest 声明了 icons"
t "grep -q 'rel=\"manifest\"' web-ui/index.html"                       "index.html 链了 manifest"
t "grep -q 'name=\"theme-color\"' web-ui/index.html"                   "index.html 有 theme-color"
t "grep -q 'apple-touch-icon' web-ui/index.html"                       "iOS「添加到主屏幕」需要的 apple-touch-icon 有"
t "grep -q 'viewport-fit=cover' web-ui/index.html"                     "viewport 带 viewport-fit=cover（配合安全区）"
t "grep -q 'name=\"referrer\" content=\"no-referrer\"' web-ui/index.html" \
  "meta referrer=no-referrer（?token= 不再经 Referer 外泄）"
t "test -f web-ui/public/icons/icon-192.png && test -f web-ui/public/icons/icon-512.png" \
  "192/512 两尺寸图标都在"
t "grep -q '@media (max-width: 720px)' web-ui/src/styles.css"          "有 720px 断点"
t "grep -q '@media (max-width: 390px)' web-ui/src/styles.css"          "有 390px 断点（目标机型宽度）"
t "grep -q 'env(safe-area-inset-top)' web-ui/src/styles.css"           "处理了刘海/安全区"
t "grep -q 'min-height: 100dvh' web-ui/src/styles.css"                 "外壳用 dvh（移动端地址栏不再吃掉一屏）"
t "grep -q 'min-height: 44px' web-ui/src/styles.css"                   "触摸目标 ≥44px"
t "grep -q 'font-size: 16px' web-ui/src/styles.css"                    "窄屏输入 16px（iOS 聚焦不放大）"
t "awk '/@media \\(max-width: 720px\\)/,0' web-ui/src/styles.css | grep -q 'grid-template-columns: 1fr'" \
  "窄屏：外壳从两列收成单列（侧栏变顶部横向标签条）"
t "awk '/@media \\(max-width: 720px\\)/,0' web-ui/src/styles.css | grep -q 'overflow-x: auto'" \
  "窄屏：表格/导航可横向滚动而不是压扁"
t "awk '/@media \\(max-width: 720px\\)/,0' web-ui/src/styles.css | grep -q 'flex-direction: column'" \
  "窄屏：日志行改为堆叠（topic 不再占死 190px）"

echo "⑧ 构建与类型"
t "npm run build:web >/dev/null 2>&1"                    "npm run build:web 通过"
t "test -f web-ui/dist/manifest.json"                    "构建产物含 manifest.json（daemon 能托管）"
t "test -f web-ui/dist/icons/icon-192.png"               "构建产物含图标"
t "grep -q 'rel=\"manifest\"' web-ui/dist/index.html"     "构建后的 index.html 保留 manifest 链接"
t "! npx tsc --noEmit 2>&1 | grep -qE '^src/surfaces/(http|config)\.ts'" \
  "tsc 对本轮两个改动文件无错误（其余文件的错不归 F6）"

echo "⑨ 既有测试没被本轮改动打破"
t "node --import tsx --test tests/surfaces-channels-web-config.test.ts >/dev/null 2>&1" \
  "surfaces-channels-web-config（含真实 config/dotd.yml 的 host/allowed_origins 断言）全过"
t "node --import tsx --test tests/surfaces-http-hmac.test.ts >/dev/null 2>&1" \
  "surfaces-http-hmac（鉴权 / Origin / HMAC）全过"
t "node --import tsx --test tests/surfaces-sse.test.ts >/dev/null 2>&1" \
  "surfaces-sse（含真 /api/stream 连接）全过"
t "node --import tsx --test tests/surfaces-observability.test.ts >/dev/null 2>&1" \
  "surfaces-observability（真 HTTP 起 server）全过"
t "node --import tsx --test tests/vault.test.ts >/dev/null 2>&1" \
  "vault.test.ts 全过（保险库本体没被回环门控碰坏）"

echo "  ══════════════════════════"
echo "合计 $PASS 通过 / $FAIL 失败 / $SKIP 跳过"
[ "$FAIL" = "0" ] && { echo "PASS: web-console-criteria 全过（$PASS 通过，$SKIP 跳过）"; exit 0; }
exit 1
