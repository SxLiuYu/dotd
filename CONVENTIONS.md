# dotd 仓库约定（CONVENTIONS.md）

本文件是**全仓库约定的唯一权威**。八个并行实现者开工前必读；与设计文档冲突时，以
`docs/design/` 下文档原文为准，并在 PR 里指出本文件需改哪一条。

骨架搭建期已完成的验证结论集中在「已验证事项」节，未验证的明确标注，不要凭印象假设。

---

## 1. 运行环境与模块系统

- **运行环境 = 本机原生 Windows Node 24（不在 WSL）**。Node 版本实测 `v24.13.0`。
  WSL2 只承载 Docker daemon 与 Playwright 容器（CONTEXT.md 机器约束）。
- **ESM-only**：`package.json` 有 `"type": "module"`，**不写 CJS**。没有
  `require`、没有 `module.exports`、没有 `__dirname`（要目录用
  `fileURLToPath(import.meta.url)`，见 `db/migrate.ts`）。
- **import 必须带扩展名 `.ts`**：`import { ulid } from './ulid.ts'`。
  - 原因（已验证）：Node 24 的 ESM 解析器**不会**把 `./leaf.js` 映射到 `./leaf.ts`
    （实测 `ERR_MODULE_NOT_FOUND`）。tsx 会做这个映射，但 Node 原生
    type-stripping（`--experimental-strip-types`）不会，而我们的启动脚本两种都要能跑。
  - 好处：同一份源码 `node --experimental-strip-types` 与 `node --import tsx` 都能跑。
- **`import type` 强制**：tsconfig 开了 `verbatimModuleSyntax: true`。类型导入一律
  `import type { X } from '...'`，值/类型混用时分开两行写。不要用 `import { type X }`。
- tsconfig 关键项：`module: NodeNext` / `moduleResolution: NodeNext` /
  `strict` / `noUncheckedIndexedAccess` / `noImplicitOverride` /
  `noFallthroughCasesInSwitch` / `exactOptionalPropertyTypes: false`。
  - `noUncheckedIndexedAccess` 意味着 `arr[0]` 类型是 `T | undefined`——访问前判空或用 `!`，
    不要为了消错把数组类型改成 `any`。

## 2. 依赖决策

- **数据库：内置 `node:sqlite`（`DatabaseSync`），不装 better-sqlite3。**
  - 验证命令（本机实测通过）：
    `node -e "new (require('node:sqlite').DatabaseSync)(':memory:'); console.log('OK')"` → `OK`
  - 影响：设计文档 §9.6 依赖清单里的 `better-sqlite3` 由本条替代。差异点：
    - API 是同步的（`prepare().get()/.all()/.run()`、`exec()`），**没有 async 变体**，
      不要写 `await db.prepare(...)`。
    - 查询结果行是 `[Object: null prototype]`（无原型对象），`JSON.stringify` 正常，
      但不要往行上挂属性。
    - Node 24 仍标 Experimental，每次启动会打一条
      `ExperimentalWarning: SQLite is an experimental feature`。
      **处理方式：所有 node 启动命令带 `--disable-warning=ExperimentalWarning`**
      （见 package.json scripts），不要用 `--no-warnings`（会把真告警一起吞了）。
- **运行期依赖只取设计文档点名的**：`commander`（CLI，SF §5.6）、`cron-parser`
  （crontabs.next_fire 计算，契约 H1）、`dockerode`（容器操作，契约 J5：归 EX 用
  dockerode stats API，不写 docker CLI 子进程）、`zod`（GOV §2.3 配置校验）。
- **能用内置模块的不用第三方**：HTTP 用 `node:http`、SQLite 用 `node:sqlite`、
  哈希/HMAC 用 `node:crypto`、ULID 用 `src/shared/ulid.ts`（已实现，勿引 ulid 包）、
  路径用 `node:path`、临时文件用 `node:fs`。
- devDeps：`typescript` + `tsx` + `@types/node`。web-ui 单独一份 package.json
  （react/vite），与主包隔离。
- **不要跑 `npm install`**（编排脚本统一跑）；不要往 package.json 加未在设计文档
  出现的依赖，确需新增先在 PR 说明里引设计文档出处。

## 3. npm scripts 与调用方式

主包 scripts（均可用 `npm --prefix dotd run X` 从工作区根调用）：

| script | 命令 | 说明 |
|---|---|---|
| `dotd` | `node --import tsx src/surfaces/cli.ts` | CLI 入口 |
| `serve` | `node --import tsx src/daemon.ts` | daemon 装配层 |
| `typecheck` | `tsc --noEmit -p .` | 全量类型检查（src+tests） |
| `test` | `node --import tsx --test "tests/*.test.ts"` | 跑 tests/ 全部测试 |
| `build:web` | `npm --prefix web-ui run build` | 构建 Web UI |

- 测试 glob 必须加引号（`"tests/*.test.ts"`）：cmd.exe 不做 glob 展开，
  引号交给 node 自己展开。已验证：无匹配文件时 `node --test` 退 0 并报 `tests 0`，
  不会让 `npm test` 在空 tests/ 目录上失败。
- web-ui 的 `build` = `tsc --noEmit` + `vite build`，两层都要过。
- **tsx 是必需的**（不是可选加速器）：`node --import tsx` 让 `.ts` 扩展名 import
  在 Windows 原生 node 下可解析。详见第 1 节。

## 4. 模块边界（铁律）

- 目录即边界。每个模块**只动自己的目录与自己的测试**：

  | 模块 | 源码目录 | 测试文件 |
  |---|---|---|
  | 控制面 CP | `src/control-plane/` | `tests/control-plane-*.test.ts` |
  | 模型路由 MR | `src/router/` | `tests/router-*.test.ts` |
  | 治理 GOV | `src/governance/` | `tests/governance-*.test.ts` |
  | 执行面 EX | `src/exec/` | `tests/exec-*.test.ts` |
  | 记忆 MEM | `src/memory/` | `tests/memory-*.test.ts` |
  | 交互面 SF | `src/surfaces/` | `tests/surfaces-*.test.ts` |
  | Runner | `src/runner/` | `tests/runner-*.test.ts` |

- **共享层 `src/shared/`、`db/`、`config/`、`tests/helpers.ts`、`web-ui/` 由骨架期定版，
  修改需全组可见**（PR 标题带 `[shared]`）。要加跨模块类型 → 改
  `src/shared/contracts.ts`，不要在模块里另起一份。
- **禁改他人模块**：不要动别人的 `src/<module>/` 与别人的 `tests/<module>-*.test.ts`。
  发现别人的 bug → 在 PR 评论里指出，或提 issue，不要顺手改。
- `src/daemon.ts` 是装配层（openDb → migrate → 模块 init 顺序 CP→MR→GOV→EX→MEM→SF），
  接线改动集中在它；模块内部不知道装配细节。
- `db/migrations/` 六个 SQL 是**一字不改**从设计文档 §9.2 拆来的（表结构逐字）。
  **不要改已发布的迁移包**；要改表结构就新增 `060_*.sql`（契约 D2/D3）。

## 5. 数据库约定（契约 D1–D4）

- **唯一库文件 `~/.dotd/dotd.db`**（契约 D1）。路径解析：显式参数 > `DOTD_DB_PATH` >
  `~/.dotd/dotd.db`，实现见 `db/conn.ts:resolveDbPath`。
- **全 daemon 共享一条连接**（契约 D2）。`openDb()` 只调一次（daemon.ts 装配层），
  之后把同一个 `DatabaseSync` 传给各模块 init。**不要 `new DatabaseSync` 第二次**。
- **PRAGMA 三条由启动者设一次**（契约 D2）：`journal_mode=WAL`、`synchronous=FULL`、
  `busy_timeout=5000`。实现在 `db/conn.ts:ensurePragmas`，`openDb()` 与 `migrate()`
  都会调（幂等）。
  - **`PRAGMA synchronous` 不允许在事务内执行**（实测报
    `Safety level may not be changed inside a transaction`，即使值与默认 2 相同）。
    所以迁移 runner 把每个包里的 PRAGMA 语句拆到 `BEGIN` 之前单独跑
    （`db/migrate.ts:loadPackages` 的 pragmas/ddl 分流就是这个原因）。
- **`foreign_keys` 不全局 ON**（契约 D2）。DDL 里的 `REFERENCES` 仅供人阅读；
  约束靠"写入顺序自律"。同属主 FK 允许，**跨模块 FK 禁止**。
- **迁移版本 = `PRAGMA user_version`**，文件前缀 NNN 即目标版本：
  `000→0 … 050→50`。验收线（§9.7 D1）：迁移后 `user_version=50`，共 39 张表。
- 表所有权以 `src/shared/contracts.ts:TABLE_OWNERSHIP` 为唯一权威（契约 D4）。
  **只写自己的表**；读别人的表一律走对方的服务接口，不直接 SELECT
  （MR 表唯一例外见契约 T3 OUTBOX 守门）。
- 不建 `meta` 表（契约 D3 作废）；kv 状态用各模块自有表
  （`gov_seq`/`router_state`/`mem_maintenance_state`/`surf_sse_cursor`）。
- 迁移失败 → `MigrationError` → daemon **拒启动** + 写 OUTBOX.md（CP §7.1 步骤 1）。
  OUTBOX 的具体格式归 MR（契约 T3：MR 块格式 `## [ts] HELP <sig>…` + `---`），
  装配层只负责"追加"这个动作，不要自造格式。

## 6. 跨模块接口（契约铁律）

- **八个模块只 import `src/shared/contracts.ts` 定义的跨模块接口，不得各自另定接口。**
  模块私有类型放各自的 `src/<module>/types.ts`。
- 术语以契约 §9 统一术语表为准，**作废词不要出现在新代码里**：
  - 步身份 = `call_id`（ULID）；不是 `step_id`，不外泄 `(task_id,seq)`
  - 事件表 = `events`；不是 `event_log`/`heartbeat_target`
  - 事件投递 = `cp.ingestEvent` / `cp.submit`；不是 `submitEnvelope`/`Envelope`/`enqueue`
  - 任务挂起等模型 = `paused(stop_reason='circuit_open')`；不是 `waiting_model`
  - 路由轨道 = `track:'primary'|'light'`；不是 `routeHint:'low'`/`completeMain`
  - 熔断耗尽 = `AllEndpointsDownError`/`NoQualifiedPrimaryError`；不是 `NoChannelAvailable`
  - 登录态判据 = 顶层 `ToolCall.identity`（谓词见 `contracts.ts:isLoginSensitive`）；
    不是 `params.withIdentity`、不是 tools.yml 的 `identityParam`（契约 G1 已作废）
  - 审批单 = GOV 八态 + `Verdict` 三值；不是 4 态投影、不是 `deliver_state`
  - 会话 = thread ≡ session；恢复唯一入口 `buildSessionReplay(threadId,…)`
  - Dot 占位 = `dot1`；不是 `main`；无 dots 表（阶段三前）
  - HTTP 监听 = `127.0.0.1:7788`（SF 属主）；不是 8642
  - cron 宿主 = `ControlPlane.registerInternalJob`；不是 `registerIntervalJob`
  - DB = `~/.dotd/dotd.db` + `user_version`；不是 `control.db`/`db/main.db`/`meta.schema_version`
- 错误类一律从 `src/shared/errors.ts` 取；跨模块判定用 `instanceof` + 机读 `code` 字段。
- 事件总线：`src/shared/bus.ts` 的 `EventBus` + `TOPICS` 表。**两套命名风格并存是既成事实**
  （GOV 用 `approval:created` 冒号族，其余用 `router.mode_changed` 点号族）——
  接缝契约逐字采纳了各模块发布名，**不要"统一"它们**；新事件归入既有前缀族。

## 7. stub 模式环境变量约定

两个变量控制"不接外部世界"的测试/开发模式，由 `daemon.ts` 装配层在启动时读取：

| 变量 | 值 | 语义 |
|---|---|---|
| `DOTD_MODEL_TRANSPORT` | `stub` | 模型调用走内存 stub，**不发任何网络请求**。预置响应由测试/CLI 注入；耗尽即抛错（等价"全灭"），不静默返回空。 |
| `DOTD_FLEET` | `stub` | 执行面 fleet 走内存 stub，**不起 Docker 容器**。幂等语义与真实 ledger 对齐：同 `call_id` 第二次进入直接重放首次结果，不再次执行。 |

- 非 stub 值或缺省 = 真实路径（OpenRouter/本地模型 + 真实容器）。
- 测试**不经过装配层**，直接调 `tests/helpers.ts` 的 `makeStubTransport()` /
  `makeStubFleet()`；变量本身供 daemon/dev 环境使用。
- `DOTD_DB_PATH` 是第三个相关变量（契约 D1）：测试用它（或显式传参）把库指到临时目录，
  **绝不碰真实 `~/.dotd`**。`tests/helpers.ts:makeTempDataDir()` 已封装好。

## 8. 测试约定

- 测试文件命名：`tests/<module>-<主题>.test.ts`（如 `tests/router-breaker.test.ts`），
  与模块目录一一对应；`tests/` 下不放模块私有 fixture（放模块自己目录或 helpers）。
- 公共脚手架只用 `tests/helpers.ts`：`makeTempDataDir()`（临时数据树 + 已迁移库）、
  `makeStubTransport()`（模型 stub）、`makeStubFleet()`（fleet stub）。
  **不要在测试里 `new DatabaseSync(':memory:')` 另起炉灶**——那会绕过 PRAGMA 约定与迁移。
- 每个测试用完调 `cleanup()`（幂等，重复调用安全）。
- 跑：`npm --prefix dotd test`。
- 断言错误类型用 `assert.throws(fn, ErrorClass)` 形式，不要只匹配 message 文案。

## 9. 已验证事项（骨架期实测，Node v24.13.0 / 原生 Windows）

以下结论都在本机跑过，可以直接依赖：

1. `node:sqlite` 可用（见第 2 节验证命令）。
2. Node 24 ESM **不**做 `.js` → `.ts` 映射（实测 `ERR_MODULE_NOT_FOUND`），
   所以 import 一律写 `.ts` 扩展名。
3. `--experimental-strip-types` 可直跑 `.ts`（`process.features.typescript === 'strip'`），
   与 tsx 行为一致——本文件的验证探针就是这么跑的。
4. `PRAGMA synchronous=FULL` 在事务内执行报
   `Safety level may not be changed inside a transaction`（即使值与默认相同）。
5. `PRAGMA user_version=N` 在事务内可执行；迁移包整体 `db.exec()` 多语句 + 注释安全。
6. 坏包回滚可靠：`BEGIN IMMEDIATE` 内任一句失败 → 整包回滚（连第一条
   `CREATE TABLE` 都不留），`user_version` 不变。
7. `node --test "tests/*.test.ts"` 引号 glob 在 cmd.exe 下可用；无匹配文件退 0。
8. `--disable-warning=ExperimentalWarning` 可精准消掉 sqlite 的 ExperimentalWarning，
   与 `--import` 组合无冲突。
9. 六个迁移包实跑：`user_version` 0→50，39 张表，与契约 D4 表清单逐名一致；
   二次调用幂等（`applied: []`）。
10. `src/shared/ulid.ts`：2 万枚同毫秒严格递增、5 万枚无重复。
11. `EventBus`：坏订阅者抛错被隔离，发布方与其余订阅者不受影响。
12. `tests/helpers.ts` 三工厂实跑通过（临时目录/迁移/stub transport/stub fleet 幂等重放）。

**未验证（不要假设）**：`npm install` 之后的 `npm run typecheck` / `npm test` /
`npm run build:web` 是否全绿——骨架期禁止安装，这三条由编排脚本装完后跑。
web-ui 的 vite 版本是从 registry 查的最新版（vite 8.3.4 / react 19.3.1 /
@vitejs/plugin-react 6.1.2），未在本机构建过。

**骨架期的类型预检（非正式结论，仅说明"改过什么"）**：曾借另一项目的 tsc
（typescript 6.0.3）对本仓库跑过 `--noEmit`，据此修掉三处会在正式 typecheck
翻车的问题——① tsconfig 缺 `allowImportingTsExtensions`（`.ts` 扩展名 import 必需，
与 `noEmit: true` 配套）；② `tests/helpers.ts` 解构 `splice` 返回值在
`noUncheckedIndexedAccess` 下为 `T | undefined`；③ web-ui 的 `React.JSX.Element`
命名空间在 `verbatimModuleSyntax` 下不可用，改为 `import type { JSX } from 'react'`。
web-ui 剩余报错全部是 `Cannot find module 'react'` 及其 JSX 连锁（包未装），
CSS side-effect import 已由 `web-ui/src/vite-env.d.ts` 的 `declare module '*.css'` 兜住。
**这不等于正式 typecheck 通过**——借来的 tsc 版本与 dotd 声明的 typescript 5.9.3
不同，且 `@types/node` 不是 dotd 声明的那版。

## 10. 常见坑（踩过再写）

- Windows 路径：SQLite 需要 Windows 风格路径（`C:/Users/...` 或反斜杠）；
  bash 的 `/tmp` 与 node 眼里的 `/tmp` 不是同一处。测试里一律用
  `os.tmpdir()` 拼路径，不要硬编码 `/tmp`。
- `mkdtempSync` 的返回值是已创建的目录，直接往里拼文件名即可，不用再 `mkdirSync` 根。
- `db.exec()` 一次执行整个迁移包是可以的（第 5 节已验证），但**PRAGMA 语句必须拆出去**。
- 异步测试里不要 `await` 同步的 `db.prepare(...)`（node:sqlite 没有 async API，
  await 一个非 promise 值只是白等一个 microtask）。
