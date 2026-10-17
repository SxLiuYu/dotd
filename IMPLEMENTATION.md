# dotd 实施报告（阶段一）

> 本文记录 dotd 阶段一实现的真实状态：**已实现范围 vs 设计文档阶段一清单**、三道门禁的实测
> 结果、与真实环境的差距、明天怎么开始用、阶段二入口清单。
>
> 写作原则（与 `CONVENTIONS.md` 一致）：**只写实测过的事**。每一项都给出可复核的出处
> （代码 `path:line`，或本次实跑的命令与输出）。凡未验证的一律明确标注「未验证」，
> 不用推测填空。语义争议以 `docs/design/` 为唯一仲裁。
>
> 环境基线：**Node v24.13.0 / 原生 Windows 10.0.19045**（`CONVENTIONS.md:12`：不在 WSL）。
>
> ---
>
> ## ⚠️ 2026-10-17 修订说明（必读）
>
> 本文写于阶段一收尾时，此后仓库继续演进，**原文有多处已过期**。本次逐条核对后修订如下，
> 未核对到的部分仍可能是旧值——引用本文数字前请自行复核。
>
> | 原文说法 | 实际（2026-10-17 实测） |
> |---|---|
> | `db/migrations/` 共 6 个迁移包 | **8 个**：`000`–`070`，新增 `060_feishu_channel`、`070_inbound_seen` |
> | 迁移后期望 `user_version = 50` | **`expectedVersion: 70`**（`src/daemon.ts:413`），实测库内 `PRAGMA user_version = 70` |
> | `exec-image/Dockerfile` **不存在** | **已存在**（2626 字节，`2026-10-16 12:37`） |
> | `scripts/` 只有 `smoke.mjs` | **17 个非临时脚本**（`daemon-launch.sh` / `dev-run.sh` / `setup-dev-env.sh` / `win-relay.mts` / `wsl-*.mts|.sh` / `init-config.mjs` 等）；`tmp-*` 探针已于 2026-10-17 删除，删前逐字节备份到仓库外 |
> | `tests/` 37 个 `.test.ts` | **48 个** |
> | 全量测试 807/807 | **1004/1004**（48 文件，92 suites；2026-10-17 多次实跑均 0 失败；末次 19:12 快照为 1004 用例 / 48 文件） |
> | `journal-blobs/` 50 个 `.json` | 93 个 |
>
> 另外，原文**完全没有提飞书通道**——而飞书已是现役入站/出站通道（WS 长连接，见新增的 §6）。
> 原文 §3.3 称"三个运维脚本未创建"、§5 把 `exec-image/Dockerfile` 列为阶段二前置，这两处已随之失效。
>
> **测试总数是流动的**：`tests/` 在活跃迭代中（`tests/router-config.test.ts` 于 2026-10-17 13:22
> 还被改过，总数因此从 873 经 879 / 935 / 976 变成 1004）。上面的数字是当日实跑值；引用前建议自己数：
> `grep -hcE "^[[:space:]]*(test|it)\(" tests/*.test.ts | awk '{s+=$1} END {print s}'`
> （静态 `test()` 数与运行数一致，套件无动态注册）。
>
> 关于"原生 Windows vs WSL"的对立说法：原文按 `CONVENTIONS.md:12` 写"不在 WSL"，
> 但 `docs/design/CONTEXT.md:34` 写"控制面 daemon 跑 WSL 内"，且 `src/exec/types.ts:154`
> 硬编码 Unix socket。该矛盾**至今未仲裁**，详见 `README.md`「已知问题」。

---

## 1. 已实现范围 vs 设计文档阶段一清单

阶段一范围原文（`docs/design/自主Dot系统设计方案.md:364`）：

> daemon+SQLite 队列+journal、OpenRouter 主循环、Playwright 容器、文件记忆、CLI/Web 审批、
> 心跳与 HTTP 事件入口、降级到本地模型。……**不含**：Telegram、email、免费池实接入、
> 多 Dot、反检测增强。

### 1.1 逐模块对照表

| # | 设计阶段一项 | 落点（实测存在） | 状态 | 依据 / 说明 |
|---|---|---|---|---|
| 1 | daemon 装配层（init 顺序 CP→MR→GOV→EX→MEM→SF，注入全部 deps） | `src/daemon.ts:379 assembleDaemon()` | ✅ 已实现 | 顺序见 `:385`(①db+migrate) `:401`(②bus+sse) `:474`(③CP) `:519`(④MR) `:530`(⑤GOV) `:557`(⑥EX) `:586`(⑦MEM) `:629`(⑧SF http)；`scheduler.start()` 在 `:674` |
| 2 | SQLite 唯一库 + 39 表全量 DDL + `user_version` runner | `db/migrations/000…070_*.sql` 共 8 个迁移包 | ✅ 已实现 | 实测 `ls db/migrations/` = 8 个 `.sql`（000–070）；`src/daemon.ts:413` 期望 `user_version=70`，实测库内即 70 |
| 3 | 队列 + journal（pop 单写者、epoch 围栏、finish 退避、崩溃矩阵） | `src/control-plane/{queue,journal,scheduler,recovery,guard,evict,match}.ts` | ✅ 已实现 | `tests/control-plane-*.test.ts` 覆盖 §4.1 三条硬门控 / §2.2 围栏 / §7.2 崩溃矩阵 |
| 4 | OpenRouter 主循环（Runner 协程） | `src/runner/dot.ts` | ✅ 代码已实现 | **真实 OpenRouter 调用未在本环境跑过**（见 §3）；`tests/runner-main.test.ts` 用 stub |
| 5 | Playwright 容器 | `src/exec/*` + `agent-runtime/*` | ⚠️ 代码已实现、本机未验证 | 本机无 docker（见 §3）；真实路径经 `DOTD_FLEET` 门控 |
| 6 | 文件记忆（注入/seal/limits/retention/compaction） | `src/memory/*` | ✅ 已实现 | `tests/memory-*.test.ts` |
| 7 | CLI 审批 | `src/surfaces/cli.ts` | ✅ 已实现 | 子命令 `serve/status/ask/approvals/approve/deny/watch/events/logs/task/cancel/hook/hb/sos-test` |
| 8 | Web 审批 + 六视图 | `web-ui/src/views/*.tsx`（6 个） | ✅ 已实现 | Chat/Queue/Approvals/Events/Models/Logs；构建产物由 daemon 静态托管 |
| 9 | 心跳调度器 | `src/control-plane/scheduler.ts` + `src/surfaces/heartbeat-tick.ts` | ✅ 已实现 | `heartbeat.tick` job 注册于 `src/control-plane/index.ts:186`；CP 自跑 `scanCrontabs` |
| 10 | HTTP 事件入口（webhook/JSONL） | `src/surfaces/{http,ingress}.ts` | ✅ 已实现（JSONL 轮询循环未接线） | webhook HMAC + 限流 + dedup 全量；`jsonl_watch` 默认 `enabled:false`（SF 已申报） |
| 11 | 降级到本地模型（mode 链 + light 轨 tier2 承接） | `src/router/{mode,breaker,candidates,pool,transport}.ts` | ✅ 已实现 | mode 链 `NORMAL→LOCAL_FALLBACK→EMERGENCY→RESTRICTED→TOTAL_OUTAGE`；tier2 默认行在 `config/models.yml:36,48` |
| 12 | 模型熔断持久化 + OUTBOX 求救 | `src/router/breaker.ts` + `src/router/outbox.ts` | ✅ 已实现 | `breaker_state` 持久化；阶段一 `channels=null` 全走 `OUTBOX.md` |
| 13 | 治理审批（evaluate/decide/claim/记忆化授权） | `src/governance/*` | ✅ 已实现 | `tests/governance-*.test.ts` |
| 14 | **装配层优雅退出**（SIGTERM/SIGINT → 同一 shutdown 路径） | `src/daemon.ts:726-736` | ✅ 已实现 | 见 §1.3 的 Windows 信号实况 |
| 15 | 端到端冒烟脚本 | `scripts/smoke.mjs` | ✅ 已实现 | 11 条断言，见 §2 |

**汇总**：15 项中 14 项「已实现」，1 项「代码已实现但本机未验证」（Playwright 容器真实路径）。
未实现项集中在阶段二（见 §5）。

### 1.2 目录与设计目录树的差异

`docs/design/自主Dot系统设计方案.md:371-404` 的 §9.1 目录树逐项核对（`ls` 实测）：

| 设计条目 | 实际 | 说明 |
|---|---|---|
| `src/` 八个模块目录 | 全部存在 | 另多 `src/event-rules.ts`（CP 匹配规则层加载器） |
| `db/migrations/` 六个包 | **8 个**（000–070） | 设计目录树之后追加了 `060_feishu_channel`、`070_inbound_seen`；`src/daemon.ts:413` 按 `expectedVersion: 70` 迁移，实测库内 `PRAGMA user_version = 70` |
| `config/` 六个 yml | 一致 | `dotd.yml` / `models.yml` / `free-models.yml` / `tools.yml` / `rules.yml` / `event-rules.yml` |
| `agent-runtime/` 七文件 | 一致 | `server/ledger/browser/fs/shell/xvhfd` + package.json + tsconfig.json |
| `exec-image/Dockerfile` | **已存在**（2626 字节） | 阶段一申报时确为缺口（`exec-image/` 仅 `.gitkeep`），2026-10-16 已补齐。容器内运行时真实路径仍未端到端验证（见 §3） |
| `scripts/` 三个运维脚本 | **17 个非临时脚本**（`tmp-*` 探针已于 2026-10-17 删除，删前逐字节备份到仓库外） | 设计列的 `wsl-bootstrap.sh` / `portproxy.ps1` / `calibrate-watermark.sh` 仍未创建；实际有的是 `smoke.mjs` / `daemon-launch.sh` / `dev-run.sh` / `setup-dev-env.sh` / `win-relay.mts` / `wsl-*.mts|.sh` / `init-config.mjs` 等。另有 17 个 `tmp-*` 一次性探针（`.gitignore` 已挡，不入库） |
| `web-ui/` | 存在且已填实 | 设计此处写「Vite+React18」，实际按 `package.json` 装 React 19.3.1（版本以 registry 最新为准，`CONVENTIONS.md:199`） |
| `tests/` | 45 个 `.test.ts` | 阶段一时 37 个，飞书通道接入后增至 45 |

另有两处**非设计内**的实际状态需记账：

- `dotd/journal-blobs/` 有 93 个 `.json`，是某次测试运行把 blob 目录指到了仓库相对路径留下的。`.gitignore` 已含 `journal-blobs/`，不会入库；不影响门禁，但建议清掉。
- `dotd/web-ui/node_modules/` + `package-lock.json` 存在（本次为跑通 `build:web` 按编排脚本授权安装，见 §2.3）。`.gitignore` 已含 `node_modules/`。
- **`docs/design/` 不在设计目录树里，但已于 2026-10-17 从仓库上一级 `../dotd-design/` 移入**（9 个 markdown：`CONTEXT.md`、`自主Dot系统设计方案.md`、`modules/` 下六模块加接缝契约）。这是分发缺口的修补：移入前，只拿到 `dotd/` 文件夹的人解析不了本文任何 `docs/design/...` 引用。库内共 47 个文件的引用已同步改写，原文行号未变（文件原样搬移，仅 `modules/model-router.md` 里三处本机 WSL 宿主 IP `172.17.48.1:18001` 改为 `127.0.0.1:18001`）。

### 1.3 各模块写手申报的偏差（全部如实列出）

以下按模块原样收录申报。标注 ✅ 的表示本次整合期已解决；标注 ⬜ 的表示仍是当前状态。

#### 控制面与任务队列

- ⬜ 【违反 CONVENTIONS §4，环境妥协】`src/router/ModelRouter.ts` 的块注释里 `pool.probe.*/recon.scan/breaker.probe_timer/router.janitor` 中的 `*/` 提前终止注释，导致全仓 29 个 TS 语法错误（含控制面文件）。已把该处改为 `pool.probe.* / recon.scan / breaker.probe_timer / router.janitor`（仅加空格，未动任何逻辑）。修完后 router 模块零错误；这是本次唯一动到本模块之外的源码文件。
- ⬜ 【契约追加，不改语义】`src/shared/contracts.ts` 的 ControlPlane 接口追加了 `journal.resumeStep(taskId, epoch, seq, argsJson?)`（CP §7.4 审批续跑要把 pending→started 并复用原 call_id，原接口缺此入口）；`reconcileAndResolve` 由同步改为 async Promise 返回（CP §5.3 的 unknown 分支必须 await `exec.reconcileCall`/`getCallResult`，同步签名无法表达）。均为新增/必要签名演进，未改已有签名语义。
- ⬜ 【实现缺口补齐】`match.ts decideAndCreate` 的 run_new 分支原来只 submit 不写 event_decisions，违反 CP §6.1「建任务 + 写决策同一事务」的幂等核心（重启 replay 会双建任务）。已补 insertDecision。
- ⬜ 【实现缺口补齐】`evictForIncoming` 被 match.ts 调用时未传 record/bus，淘汰只改状态不落 resource_events(kind='queue_evict')，违反 CP §4.4。已把 MatcherDeps.record 接入，并把 evictForIncoming 的 deps 参数放宽为 Partial（record 可选），index.ts 装配层同步接线。
- ⬜ 【实现缺口补齐】`guard.ts unfreezeIfRecovered` 在 pausedDots 为空时提前 return，导致「paused(stop_reason='watermark') 任务批量回 queued」的 SQL 永不执行（水位从未进过 throttled、但别处 pauseByReason 落过 watermark 暂停的任务永远卡死）。已把容器解冻与任务回队拆开，任务回队不再被提前 return 短路。
- ⬜ 【实现缺口补齐】`scheduler.watchdog` 原来只在「心跳超时」的 stale 集合里做预算硬兜底，而 CP §6.4 要求 usage≥1.2×budget 时看门狗旁路 abort（与心跳是否新鲜无关——Runner 可能卡在预算判断之前）。已拆成两步：先扫所有 running 判 budget 硬兜底 → failed + 记 kind='budget'，再做心跳超时回收（跳过①已处理的）。
- ⬜ 【语义澄清】`scheduler.tick()` 原来 `if (this.stopped) return`，但注释与 CP §7.1 步骤 5 都要求「测试/恢复可直接调 tick」。已去掉 stopped 检查：stop() 的语义收窄为停定时器与 popLoop，手动 tick 是显式驱动。
- ⬜ 【文件组织偏离】ask 里列的 000 迁移数据访问没有独立文件：events/crontabs 的读写在 match.ts/scheduler.ts 内（都带完整契约注释），resource_events 的写在 types.ts/guard.ts/evict.ts 内。理由：这些访问全部复用 Queue 已持有的 db 连接，独立成文件只会多一层无状态转发。DDL 与 config 未改一字。
- ⬜ 【ask 与文档的编号错位】ask 要求「tests 含文档 §7.1 的崩溃矩阵用例」，但 control-plane.md 的 §7.1 是 daemon 启动序列，崩溃窗口逐项表在 §7.2。已按后者实现：崩溃矩阵（beginTool/endTool 提交前后、finish 事务中、safe/replayable/unknown/llm 三分流）在 tests/control-plane-journal.test.ts，§7.1 启动序列 + §7.4 重领在 tests/control-plane-recovery.test.ts。
- ✅ 【遗留问题→已解决】全仓 typecheck 曾有 39 个错误（memory 12 / exec 21 / governance 7 附近）。**本次整合期已全部修掉**：`node node_modules/typescript/bin/tsc --noEmit -p .` → EXIT=0（见 §2）。
- ⬜ 【设计缺口记录】CP §6.4 的 token 预算执行主体是 Runner + heartbeat 返回位。Runner 侧接线见「主循环 Dot」模块的同名申报。
- ⬜ 【测试实现细节】`guard.applyContainerPolicy` 是 fire-and-forget 的 async（tick() 保持同步签名以符合 CP §8），容器指令记账晚于 tick 返回。测试用 flush()（setImmediate）冲刷 microtask 后再断言，未改生产代码的同步签名。
- ⬜ 【设计缺陷记录】`evictForIncoming` 的淘汰候选 SQL 未按 CP §4.4 原文限定 dotId（原文写「同 dot 的既有任务」为 merge 目标集，淘汰候选表述为「已存在的 queued 自动任务」未限 dot）。实现按字面取全局 queued 自动任务；若需限定 dot 要改 SQL，已在代码注释标明。
- ⬜ 已按审码意见修订 8 处。

#### 模型路由与容灾

- ⬜ `lightCapable()` 收窄为只认 tier2 本地端点（`src/router/mode.ts`）：§4.3 图的下一跳注释是「tier2 light 可用」，而原实现对 light 候选遍历所有 tier。tier1 云端端点的 light 轨 breaker 从未被 light 请求打过（closed，无样本），若把这种「无样本的 closed」算作可服务，云端全挂时 mode 会永远停在 RESTRICTED，永远到不了 TOTAL_OUTAGE。
- ⬜ `poolFilePath()` 改为多候选解析（`src/router/ModelRouter.ts`）：骨架配置 `dotd/config/models.yml` 里 `free_models_file` 写的是 `config/free-models.yml`，按 configDir 直拼会得到 `<configDir>/config/free-models.yml`（真实 daemon 下即 `config/config/…`，永远不存在，池静默变空）。改为按 declared → sibling(basename) → cwd 取第一个已存在者。这是对骨架配置缺陷的修复，未改表结构。
- ⬜ §4.3 末条「升级必发恢复通报」补接线：`sendRecovery` 原已定义但无调用点，在 `recomputeMode()` 里按 `MODE_SEVERITY` 比较分支，mode 变好时调用 `maybeSendRecovery()`。
- ⬜ 修 bug：`emergency_active` 落库值滞后一圈（`src/router/mode.ts persist()`）。原实现用 `this.mode`（旧值）判定，而 `apply()` 里 `this.mode=next` 在 `persist()` 之后执行，导致 mode 已切到 TOTAL_OUTAGE 而 `router_state.emergency_active` 仍为 `'0'`，治理读到的收缩位与内存 getter 不一致。改为与本次落库的 mode 同源，并抽出 `isEmergencyMode()` 供 getter 与 persist 共用。
- ⬜ 修 bug：`breaker_event` 记录噪音行（`src/router/breaker.ts persist()`）。原实现每次 settle 都写 event，含 closed→closed 的「无迁移」行——一次成功的 route 产出两行噪音，把真正的 closed→open 迁移淹掉。§3.2 DDL 语义是「迁移审计」，故改为仅状态真变时才写 event（`breaker_state` 仍每次 upsert）。
- ⬜ 无第三方 YAML 库（禁止 npm install），`free-models.yml` 用仓库内手写的极简 YAML 子集解析器（`src/router/pool.ts parseFreeModelsYaml/serializeFreeModelsYaml`），支持条目、行内数组 `models: [a, b]`、注释与 null/~。非完整 YAML，锚点/多行字符串等特性不支持。
- ⬜ 真实 OpenRouter HTTP 路径已实现（`src/router/transport.ts HttpTransport`）但仅 env 门控（`DOTD_MODEL_TRANSPORT !== 'stub'` 时才装配）；测试一律用 StubTransport 或手写 fake，零网络请求。
- ✅ 【遗留→已解决】全仓 typecheck 曾剩 7 个错误（全在 `src/runner/dot.ts`）。**本次整合期已全部修掉**（EXIT=0）。
- ⬜ 环境妥协：`node:sqlite` 在 Node 24 仍为 experimental，测试运行时会打印 ExperimentalWarning（不影响结果）。
- ⬜ 已按审码意见修订 11 处。

#### 治理与审批

- ⬜ 【DDL 冲突·设计文档内部不一致】approvals 表无 identity 列（`db/migrations/020_governance.sql:12-36` 无该列），但 §3.1/§4.2 要求 approve_remember 派生规则时判断登录态。DDL 一字不改 ⇒ `rememberFromApproval` 从 `approvals.reason` 反推身份：`'identity_missing'`⇒undefined（fail-closed 登录态）、`'login-sensitive'`⇒'owner'、其余⇒'anon'（`src/governance/gate.ts:1054-1063`）。
- ⬜ 【DDL 冲突·设计文档内部不一致】endpoint_grants 表无 last_hit_at 列（`020_governance.sql:66-75`），与 §4.3「命中即 UPDATE hits=hits+1, last_hit_at=now」和 §4.5「按 LRU(last_hit_at) 淘汰」矛盾。DDL 一字不改 ⇒ endpoint_grants 只 bump hits、LRU 退化为 id 序、listMemory 对 grant 恒返回 lastHitAt=null（`src/governance/memory-rules.ts` enforceTierCap/bumpHit/listMemory）。approval_rules 有 last_hit_at，行为完整。
- ⬜ 【列名分歧】`approval_rules.tier` 与 `endpoint_grants.tier_ceiling` 列名不同，`enforceTierCap` 按表名分支取列与 ORDER BY（`src/governance/memory-rules.ts`）。
- ⬜ 【契约 G1 语义修正】`isLoginSensitive`：identity 缺失(undefined) 才是 fail-closed 登录态；null 与 'anon' 同为非登录态（接缝契约 G1 原文「未登录浏览的表示法 = identity:'anon' 或 null」）。原实现把 null 当登录态，已改（`src/shared/contracts.ts:927-934` 与谓词实现）。
- ⬜ 【glob 语义偏差】`globToRegExp` 对 `'/x/*'` 形式同时匹配目录本身（`'/x'`），即尾部 `'/*'` 展开为 `'(?:/.*)?'`；严格 glob 语义下 `'/x/*'` 不含 `'/x'`。取宁粗勿漏口径（与 §4.2「兜底：仅记 origin 级，宁粗勿漏」一致）。
- ⬜ 【实现补齐】§7 只对 details 脱敏，audit_log 的 reason/tool 未过 sanitize；已让 `appendAudit` 对所有文本字段过 `sanitizeText`（`src/governance/audit.ts`）。
- ⬜ 【实现补齐】§3.1 末行要求「每个出口都 INSERT decisions(...) 并 audit('decision')」；原实现在登录态/rules.yml approve/review_approve/policy approve/幂等重入五个出口缺 decisions 行，已补齐（`src/governance/gate.ts` 对应分支）。
- ⬜ 【文档顺序的自然结果，非缺陷】§3.1 伪码中「read 快速路径」是第 7 步、matchRules 是第 8 步，故 read 档的人工收紧规则会被快速路径抢先放行；write_file/browser 档规则正常生效。测试按此断言并在用例注释中写明（`tests/governance-review-catalog.test.ts`）。
- ⬜ 【磁盘稿作废项】`router.lowIntelligence.complete()` 已作废，precheck/postReview 统一走 `router.complete({track:'light', deadlineMs:45000, attemptId:'nonj:…'})`（`src/governance/review.ts`）；不订阅已作废的 governance:emergency 事件，改订阅 `router.mode_changed` 并读 emergency 标志（`src/governance/gate.ts watchEmergency`）。tools.yml 的 identityParam 字段按契约 G1 作废，zod 形状已删。
- ⬜ 【文件合并】磁盘稿的 cron.ts/ledger.ts/channels/telegram.ts/queries.ts/memory.ts 五个文件并入现有文件（expirePending/recordSpendAdjustment/resolveTelegram/renderTgNotice/listPending/getApproval → gate.ts；compactAudit → audit.ts；matchMemory/deriveRule → memory-rules.ts），任务书点名的七个文件一个不少。
- ⬜ 【环境妥协】无 yaml 依赖可用（禁止 npm install），catalog.ts 内置手写最小 YAML 解析器（块映射/块序列/流式集合/标量/行尾注释），已用仓库真实 `config/tools.yml`、`config/rules.yml` 与测试用例验证；不支持锚点别名、多行折叠标量、多文档。
- ⬜ 【新增文件】新增 `src/governance/config.ts`（GOV_DEFAULTS + SANITIZE_PATTERNS，磁盘稿 §7 未单列文件）、`src/governance/policy.ts`（§2.1 策略表）、`src/governance/types.ts`（模块私有类型）、`src/governance/index.ts`（§8.1 导出面）、`tests/governance-support.ts`（测试脚手架）。
- ✅ 【遗留·等别的模块→已解决】全仓 typecheck 曾有 8 条错误（scheduler.ts:146-147 / tests/exec-*）。**本次整合期已全部修掉**（EXIT=0）。
- ⬜ 【未验证】执行/控制面/router 等模块的真实实现未接通，治理依赖（deps.router/deps.controlPlane/deps.bus）在测试里用 stub；跨模块联调未跑。**注：本次整合期 `src/daemon.ts` 已把真实实现全部接通并用冒烟端到端验证（§2），此条申报的前提已不成立；但「治理依赖跨模块联调」仍只在 stub 模型/stub fleet 下验证过。**
- ⬜ 已按审码意见修订 7 处。

#### 执行面容器

- ⬜ 环境妥协：本机无 docker（Windows 无 dockerd，WSL 侧虽有 daemon 但模块契约禁跨 WSL），真实 dockerode 路径全部经 `DOTD_FLEET` 门控；netguard 的 iptables 子进程在 stub 模式下不执行（`src/exec/netguard.ts:117 applyRules` 直接 return false），install() 只构造规则集供断言。dockerode 5.0.1 无内置类型且禁止 npm install，改在本目录写 `src/exec/dockerode.d.ts` 环境模块声明（未新增依赖）。
- ⬜ 契约追加（`src/shared/contracts.ts:955` 起，全部为新增导出，未改任何既有签名语义）：DOT_CONTAINER_STATES、EXEC_OWNED_TABLES、DotContainerState、BootReport、ReconcileEntry、DotStatusSnapshot、FsOpsRequest/FsOpsResponse、interface ExecService（ExecServiceImpl 显式 implements 它）。
- ⬜ 实现中发现并修掉的设计/代码缺陷：① exec-local FsOpsRequest.dotId 原为必填（`src/exec/types.ts:490`），与 `agent-runtime/protocol.ts:483`（可选，容器不理解）不一致，导致宿主调用方必须重复传 dotId，已改为可选；② checkHomePath 原先拒绝 home 根本身 /dot/home（protocol.ts），契约 S4' 的 list /dot/home 会被误杀，已放行；③ rotateToken 在 containers 行创建前执行导致 token_hash 静默丢失，createAndStart 中 attachDocker 后补写；④ recreate 需先经 removed→absent 前置迁移、quarantined 需经 unhealthy 中转，否则状态机非法；⑤ destroy 的 keepVolumes 语义与注释相反（默认路径反删卷），已按 kill 语义修正并加 fleet.dropVolumes；⑥ failCall 原是 UPDATE-only，本地拒绝（行尚未建）不留审计行，改为 upsert；⑦ reconcileOpenCalls 把已销毁但 endpoint 仍在库的容器当可达，加 canAcceptCalls 可服务性判定；⑧ setIdentityProfile 先于 registerDot 触发 exec_identities FK 失败，已先登记；⑨ boot 的创建循环漏调 admit() 闸门，已补（`tests/exec-state.test.ts:64` 断言 ≤2 生效）；⑩ netguard install() 曾在每次成功装规则后误发 exec.docker.unavailable 事件，已删。
- ⬜ 文档未覆盖但契约要求的实现：POST /fs/ops 桥（契约 S4'/M4）execution.md §5.2 端点表未列，按契约实现（宿主侧硬护栏 + container_not_ready 降级码）；image.ts 的 exec.image.build 事件主题不在 `src/shared/bus.ts:44` TOPICS 表内，发布时归 log 通道（bus.ts:128 的未登记主题兜底），未改共享层 TOPICS。
- ⬜ 节律妥协：execution.md §8 的每 6h cron + 构建后触发，按契约 J4（cron 宿主唯一）不在本模块起定时器，只暴露 `runOnce()`/`refreshVolumeUsage()` 等幂等方法由 CP registerInternalJob 挂载；同理 health/idle 探测为被动 probe 方法，无常驻循环。
- ⬜ stub 后端无 docker 卷列表，DiskGardener 的 prune 无主卷步骤退化为只回收在册但容器已销毁的卷（`disk.ts:120-127`），该步在 stub 下为空操作；profile 缓存清理的 freed 估计用容器侧 list 条目数近似（stub-runtime 不模拟真实字节）。
- ⬜ 测试自测（均在本轮实跑）：`node --import tsx --test tests/exec-protocol.test.ts tests/exec-state.test.ts tests/exec-idempotency.test.ts tests/exec-disk-netguard.test.ts` → 67 tests / 67 pass / 0 fail，EXIT=0。类型检查 `npm --prefix dotd run typecheck` 走的是 `tsc --noEmit -p .`，等价实跑 `node node_modules/typescript/bin/tsc --noEmit -p .` → EXIT=0 全仓零错误（npm run 形式首次执行时 node/tsc 在 cygwin 下 Zone Allocation OOM，EXIT=134，非类型错误；另 npx 会走网络代理 ECONNREFUSED，故改用 node_modules 内二进制直跑，命令与 package.json script 等价）。
- ⬜ 遗留问题（不阻塞本模块）：`exec.image.build` 主题未进 TOPICS（属共享层冻结范围）；真实 docker/iptables 路径未在本机验证，需部署环境首启时回归；busy 让路测试用直插 exec_calls 的 sent 行模拟 in-flight（`fleet.ts:987-993` 的判据），未用真实挂起的 handler（那会让测试进程挂起）。
- ⬜ 已按审码意见修订 10 处。

#### 记忆系统

- ⬜ 契约追加：`src/shared/contracts.ts` 新增 `export interface Thread`（mem_threads 行投影）。原因：inject.ts 的 packSessionReplay 与 buildSessionReplay 需要整行投影，而契约此前只登记 ThreadSummary（列表最小投影）与 Message。未改任何既有签名语义，仅在 Message 之后追加。
- ⬜ 签名扩展：`buildContextBundle` 增加第 4 个可选参 `opts?: {threadId?; taskId?}`（设计 §8 是 3 参）。原因：注入时要能把 system_error 注记与 memory_missed 归属到具体 thread/task，否则 §4.2 的降级路径无法落库。可选参数，不破坏 3 参调用。
- ⬜ 模块内扩展：`SealTaskInput extends Task` 增加可选 `newManualIds?: HomeRelPath[]`（contracts.ts 的 Task 无该字段）。原因：§4.3 伪码 `touchManualsLastUsed(task.newManualIds)` 需要它。控制面不传时退化为空列表。
- ⬜ 环境变量名自拟：`fsops-client.ts` 用 `DOTD_AGENT_RUNTIME_URL` / `DOTD_AGENT_RUNTIME_TOKEN`（设计文档与 `config/dotd.yml` 均未定义这两个名字，execution.md §5 只给了默认基址 http://127.0.0.1:9223）。
- ⬜ notesCount 统计口径实现方式偏离 SQL：homeActiveUsage 原用 SQL LIKE + ESCAPE 排除豁免文件，实测 SQLite 的 LIKE/ESCAPE/字符串字面量三重转义极难写对（TS 模板串要 8 个反斜杠才让 LIKE 模式拿到 1 个转义符；且 `'notes/_%'` 少写 .md 会把 notes/2026-01-01-x.md 全误伤）。改为取回 path 列表后在 limits.ts 新增导出的 `isNoteExempt()` 用 JS 正则判一次，口径与 NOTE_EXEMPT_RE 完全同源。索引行数千级，成本可忽略。
- ⬜ `runOutboxGuard` 无 unresolvedSignatures 探针时保守全留（一个块都不轮转）。这是对契约 T3『查不到就全留』的保守解读：真实装配层必注入 MR 的 `outboxUnresolvedSignatures()`，缺探针只可能发生在测试或装配遗漏，此时不冒丢块风险。
- ⬜ `touchManualsLastUsed` 写 mtime_ms 刷新（mem_files_index 无 last_used 列，DDL 不可改）。设计 §4.3 语义『标记 manuals 最近用过』用 mtime 承载。
- ⬜ `runRetention` 回填 task_end 时顺带把该 thread 的 `last_task_finished_at` 置为 now。原因：§6.1 封存锚点就是这个字段，回填了 task_end 却不设锚点会让该 thread 永远豁免封存。
- ⬜ `walSize()` 从恒返回 0 改为真实实现（`db.location()` + statSync(`${path}-wal`)，失败返回 0）。设计 §6.2 要求报 WAL 字节数，node:sqlite 无 WAL 查询 API，只能按 SQLite 约定拼副文件名。
- ⬜ `syncFilesIndex` 用递归 scanDir（深度上限 8）。原因：fsops 桥的 list 是单层目录项，而 classifyHomeArea('manuals') 对目录项返回 null，不递归会漏掉 `manuals/<domain>/*.md`（这是实现期发现的真实 bug）。目录项判据用 isReservedPath + 路径前缀。
- ⬜ `backfillTaskEnd` 签名从 `(deps, threadId, ...)` 简化为 `(db, threadId, ...)`（原骨架签名收 deps 而调用方传 db，会 TypeError）。
- ✅ 【外部阻塞→已解决】全仓 typecheck 曾有 34 个错误。**本次整合期已全部修掉**（EXIT=0）。其中 `tests/runner-main.test.ts:602` 的 `memStub.buildSessionReplay()` 返回 ChatMessage[] 与契约 MemoryServiceApi 的 Promise<Message[]> 不符（该契约签名在写手改动前就是这样，属存量问题）也一并解决。
- ⬜ 『损坏库』测试改用抛错假 db 而非真损坏文件：曾试过把 db 文件字节写 0xff 再 DatabaseSync 裸开，实测 node:sqlite 在 WAL 模式下打开仍成功且 integrity_check 返回 'ok'（头页未坏），复现不出损坏态。改用 `prepare().get()` 直接抛 database disk image is malformed 的假 db，等价于真实 SQLITE_CORRUPT 报错形态，与同文件已通过的 onCorruption 用例同手法。
- ⬜ 已按审码意见修订 13 处。

#### 交互面与事件入口

- ⬜ 【环境妥协】本机无任何 YAML 解析器且禁止 npm install（CONVENTIONS「依赖决策」），config.ts 内手写极简 YAML 子集读取器：注释/嵌套 map/map 列表/标量/引号串/行内流式列表 [a,b]。块标量 |/>、锚点、流式 map {}、多文档、tab 缩进不支持（遇结构性错误抛 ConfigError，不静默误解）。
- ⬜ 【设计缺陷】surfaces.md §2.1 指定 JSONL 监听用 chokidar，但依赖清单（commander/cron-parser/dockerode/zod）里没有它也不能装。§5.3 的行规范化/dedup_key(含 gen)/旋转与截断语义已在 ingress.ts 完整实现并有测试覆盖，但文件轮询循环（fs.watch 或定时 stat）未接线，留待装配层；`jsonl_watch` 默认 `enabled:false`，不影响阶段一启动。
- ⬜ 【契约缺口】crontabs 归 CP 属主（契约 D4），但 contracts.ts 的 ControlPlane 没有 crontabs 管理接口，§5.2 POST /api/heartbeat 无处转发。已在 `heartbeat-tick.ts` 实现 createHeartbeatAdmin（add/remove/setEnabled/list，直写 CP 表），注释标明「SF 提供、CP 可替换」；CP 补出 addCrontab 后应改走端口。
- ✅ 【契约缺口→本次已补齐】§4.5 重放快照的数据源（GOV listPending / CP list）需装配层注入 SseSnapshotProvider，无注入时只发 resync 帧（已测）。**本次整合期已在 `src/daemon.ts:401-424` 用惰性 holder 注入该 provider（approvals/queue 两通道），并在 `:528`/`:574` 回填。** 装配后 SSE 断线补档会带快照帧，不再只发 resync。
- ⬜ 【未接线】Telegram 全量实现按 §2.2/§5.5 分期留到阶段二：channels.ts 只落地 TelegramGateway 接口 + NULL_TELEGRAM_GATEWAY 占位（available 恒 false、deliver 如实报未装配）；TG 聊天入站只有 normalize + looksLikeApprovalCommand 判别函数。email 通道同样阶段二（SMTP_URL 未配时 available=false）。
- ⬜ 【路由表缺口】§5.2 未列 GET /api/tasks/:id、/api/logs、/api/conversations 明细等路径，CLI 的 logs/task 子命令只能经 /api/queue、/api/guard 间接回答并在输出里注明「路由待补」，未自行扩张路由表。**注：本次整合期已补 `GET /api/status`（`src/surfaces/http.ts:106`，复合探针），该条申报的路由缺口其余部分仍在。**
- ⬜ 【术语修正】SSE 帧的 event 名 = `<channel>.<kind>`，而 kind 就是 bus.ts 的 topic 全名（如 approval:created → `event: approval.approval:created`）。这是 bus.ts:126（kind: topic）与 formatFrame 拼接的自然结果，初期看着冗余，但保持了「不重造事件名」的契约；若嫌冗长应改 bus.ts 而非 surfaces。
- ⬜ 【实现 bug 修复记录】web.ts resolveStaticPath 原用 `normalize()+replace(/^([\\/])+/,'')` 剥前导分隔符，在 win32 上 normalize('/index.html') 返回 '\\index.html' 且该正则未能剥掉，导致 resolve 把它当绝对路径 → 所有静态请求都判越界 404。已改为先 `replace(/^[/\\]+/,'')` 再 normalize，并加 decodeURIComponent（防 %2e%2e%2f 绕过）。
- ⬜ 【测试妥协】「SSE 连接上限 8 → 503」的分支未写集成测试（需同时开 9 条真实长连接，进程内易悬挂）；MAX_SSE_CONNECTIONS 常量与 subscriberCount() 已导出供装配层/后续测试断言。
- ⬜ 已按审码意见修订 9 处。

#### 主循环 Dot

- ⬜ 文档定位：ask 让读《自主Dot系统设计方案.md》§12，但该文件只有 §1–§11（已通读确认无 §12 小节）；CP §12 骨架契约的实际原文在 `docs/design/modules/control-plane.md` §12（lines 635–684，含 queue.popLoop()/ctx 伪码）与 §9.1（src/runner/dot.ts 的目录树落点）。已按 control-plane.md §12 + 接缝契约 §8 ⑤–⑫ 实现。
- ⬜ 契约追加 1（contracts.ts §9 GovernanceApi.claim）：接缝 §8 ⑨ 要求「恢复执行一律 claim() 后按 final_params_json+note」，Runner 必须拿到认领后固化的参数；原 GovernanceApi 只有 evaluate/forceApproval。已在既有接口上追加 `claim(approvalId)`（`src/governance/gate.ts:1197` 的 claim 实现投影），未改动既有签名语义。
- ⬜ 契约追加 2（contracts.ts §9 MemoryServiceApi.buildContextBundle 加 opts）：仓库真实实现 MemoryService.ts:268 的签名是 `(dotId, taskText, budgetTokens, opts?:{threadId?,taskId?})`，而 contracts §9 只登记了 3 参；Runner 需要传 threadId/taskId 才能带上会话摘要。已把 opts 追加为可选参数（不破坏 3 参调用方）。
- ⬜ 契约追加 3（contracts.ts §9 ControlPlane.failTask? 可选）：CP §5.4（control-plane.md:366）规定步数硬上限 2000 → failed(stop_reason='budget')，但仓库 ControlPlane 契约面没有任何「Runner 直接把在途任务判 failed 且不经 attempt 重试」的通道（finish(ok:false) 在 attempt<max 时会回 queued 重试，queue.ts:364-383）。已追加 `failTask?` 为**可选**字段（避免给 control-plane/index.ts 的 ControlPlaneInstance 增加编译阻断——首次追加为必填时 tsc 报 index.ts(195,9) TS2741，已改可选消除），Runner 用鸭子类型探测、缺省退化为 finish(ok:false) 并在注释标明语义弱一档。**注：本次整合期已在 `src/daemon.ts` 装配层接通（转发 cp.queue.markFailed）。**
- ⬜ 【设计缺陷/遗留（等 CP 模块修）】`Queue.markFailed`（queue.ts:628-641）的 SQL 只写 status='failed'，不写 stop_reason，因此 CP §5.4 要求的 stop_reason='budget' 目前任何路径都落不了库；finish 的 failed 分支（queue.ts:384-390）同样不写 stop_reason。Runner 已把 reason 写入 summary（经 writeResult 落 task_results），测试改为断言 task_results.summary 含「步数硬上限」。这是他人模块的 SQL，未动。
- ⬜ 【设计缺陷/遗留（等 CP 模块修）】CP §12 伪码的 queue.popLoop() 在仓库里不存在于 Queue（queue.ts 无该方法），实际在 `Scheduler.popLoop(dotId='dot1')`（scheduler.ts:191）。Runner 自己实现 pop 循环（start()/runNext() + idleWait），语义等价：pop 返回 null 时等 idlePollMs 或 AbortSignal 唤醒。
- ⬜ 【设计缺陷/遗留（等 MEM 模块修）】CP §12 伪码两行 `await memory.readFileNotes(task.dotId)` / `await memory.writeFileNotes(task.dotId)` 在仓库 MemoryService 接口里不存在（已全 src/ grep 确认无 readFileNotes/writeFileNotes 任何定义）。Runner 改为：任务开始用 buildContextBundle 注入文件记忆（含 /dot/home 的 MEMORY.md 与 manuals 片段），任务结束的写记忆收口由 WRITE-SEAL（memory/seal.ts:92-99 的「未写记忆则提醒一轮」）承接。
- ⬜ WRITE-SEAL 触发权的双封风险处理：`Queue.finish()` 内部已按契约 M3 调注入的 sealTask 钩子（queue.ts:359/392/411/433 等），若 Runner 再调一次会双封。Runner 提供 `sealOnFinish` 开关，**默认 false**（= 交给 Queue 的钩子），Runner 自己的 seal() 仅在开关打开或异常路径（paused/aborted 未走 finish）时兜底，并按 (taskId,outcome,reason) 去重保证同任务只封一次。测试 fixture 按真实装配形态给 CP 注入 `sealTask=memory.sealTask`，从而端到端断言恰好一条 task_end。
- ⬜ 契约形状不一致（已在测试侧适配，未改他人文件）：contracts §9 ExecServiceApi.reconcileCall 的词表是 'done'|'aborted'|'unknown'|'unknown_host'（配 Journal 的 ExecReconciler），而真实 ExecServiceImpl.reconcileCall 返回 ReconcileEntry{outcome:'done'|'doing'|'interrupted'|'skipped'}（EX §5.3 三分流）。Runner 主循环不调它（⑫ 对账归 CP/Journal.reconcileAndResolve），测试 fixture 里做了形状适配并注明。
- ⬜ 双写禁令（S6）下的消息投影：mem_messages 的 tool_result 消息 role 只能是 MsgRole 三值（'user'|'assistant'|'system'，contracts.ts:656），没有 'tool'。Runner 在 RunContext.buildMessages 里用 `role='system'+kind='tool_result'` 落内部消息，投影成模型侧 ChatMessage 时再映射回 `role='tool'`（dot.ts toChatMessage），call_id 从消息内容正则解析（digest 预览里带 call_id）。
- ✅ 环境妥协（已消失）：申报时 dotd/ 根目录有 8 个他人会话遗留的 tmp-dbg4/6/7/8/10/11.ts 临时文件，被 tsconfig.json 的 include "*.ts" 卷入全仓 typecheck，贡献了 30 个与本模块无关的错误。**本次整合期复查：`ls tmp-dbg*` 无输出，这些文件已不在，全仓 typecheck EXIT=0。**
- ⬜ 环境妥协：本仓不是 git 仓库（git status 无输出），无法用 git 判定改动面；交付文件清单由 ls/wc 核对（src/runner/dot.ts 877 行、tests/runner-main.test.ts 608 行、src/shared/contracts.ts 1085 行）。**2026-10-17 补记：`git init` 已执行**（默认分支 `master`），此后可用 git 判定改动面；但**尚未做任何提交**，所以这段描述的历史处境仍然成立——真要靠 git 恢复，得先 commit。
- ⬜ 已按审码意见修订 7 处。

#### 容器内运行时

- ⬜ 【环境妥协】本环境不构建镜像、不跑容器（任务指令原文）。browser/Xvfb/shell 三条真实路径全部经可注入接口（SpawnAdapter / browser factory / FsToolsDeps）打桩验证，未做端到端容器验证；Xvfb 进程组看护、chromium 复用与 LRU 只由桩驱动的单测覆盖。
- ⬜ 【关键背景】`src/exec/protocol.ts` 在任务下达时并不存在（src/exec/ 只有 .gitkeep），由并行的 EX 模块在任务中途落盘。我先按 `src/shared/contracts.ts` 实现，随后补了对该文件的编译期+运行期防漂移断言，并因此发现并修正 4 处真实漂移：(a) 能力目录 browser.open/browser.act 的 sideEffect 误写 replayable（改为宿主的 unknown）、browser.close 误写 replayable（改为 safe）及两处 max_deadline_ms 不符；(b) canonicalJson 漏掉宿主 stableStringify 的「滤除值为 undefined 的键」规则（会导致 args_hash 两侧不一致，幂等对账直接失效）；(c) ledger 的「压缩」原表示为 done 记录上的 compacted 标志，改为宿主的第 4 个 LedgerState 'compacted'；(d) fs 护栏错误码名原为 path_escape/hidden_path/depth_exceeded，改为宿主的 path_outside_home/path_hidden/too_deep。
- ✅ 【原缺口→已补齐】`exec-image/Dockerfile` 在阶段一申报时磁盘上不存在（`exec-image/` 只有 `.gitkeep`）。**2026-10-16 已创建**（2626 字节，`ls -la exec-image/` 实测含 `Dockerfile` + `.gitkeep`）。其设计内容见 `docs/design/自主Dot系统设计方案.md` §9.5。容器内运行时真实路径仍未端到端验证（见 §3）。
- ⬜ 【未验证的设计项】EX §7.1 的 Q7（容器内以 uid 1001 降权执行 shell，依赖 CapAdd SETUID）在本环境无法验证。SpawnAdapter 与 canSetUid 均可注入，run() 如实回报实际 uid（检测失败时回落 RUNTIME_UID=1000），不伪装降权成功。
- ✅ 【遗留问题（他人模块）→已解决】全仓 npm run typecheck 曾有 42 个既有错误、npm test 有 23 个既有失败。**本次整合期已全部解决**：typecheck EXIT=0、全量 807/807 通过（§2）。**2026-10-17 复跑：935/935 通过（45 个测试文件，78 suites），exit 0**（注意：必须在 `dotd/` 目录下跑，见 §2.2）。
- ⬜ 【实现中修掉的一个真实缺陷】`ledger.recoverInterrupted()` 只改内存 Map、从不落盘（load() 里紧随的 flush() 因 dirty 未置位直接返回），导致重启后 doing→aborted 标记丢失、且违反 append-only。已改为对每个 doing 记录 appendFileSync 一行。此为我自己测试暴露的缺陷，非他人模块问题。
- ⬜ `compact()` 对已确认的 done 项双写 state:'compacted' 与 compacted:true：前者满足宿主 ledgerReplay() 的 result_compacted 分流，后者保留设计文档字面标记。
- ⬜ 容器侧 .dotd 隐藏前缀检查相对可注入的 homeRoot（为了可测性）；宿主 checkHomePath 把前缀硬编码为 /dot/home/.dotd。容器内 homeRoot 恰为 /dot/home，两侧行为一致；防漂移测试中宿主侧用字面 /dot/home 路径采样、容器侧用临时根采样。
- ⬜ browser.open/browser.act 的 sideEffect 取宿主的保守值 unknown（CP §5.1 三态表把 navigate 列在 safe 下，宿主最终选 unknown，与「绝不盲目重放」一致，按宿主对齐）。
- ⬜ 已按审码意见修订 20 处。

### 1.4 本次整合期新修 / 新接的跨模块缺口

除各模块已申报的偏差外，整合阶段（本报告作者）另外发现并修掉 5 处：

| # | 缺口 | 修法 | 验证 |
|---|---|---|---|
| 1 | **两个路径域没人拼**：记忆层要 home 相对路径（`src/memory/limits.ts:93` 的 `YYYY-MM-DD-<slug>.md` 命名），fleet 层要容器绝对路径 `/dot/home/<rel>`，中间断裂 | 按 `memory.md:237` 在 Runner 构造 `ExecToolCall` 的唯一汇点加 `withHomeRootArgs()`（`src/runner/dot.ts:948-966`，调用点 `:992`），对已是绝对/盘符路径的入参幂等 | 冒烟断言 `result={"path":"/dot/home/notes/2026-10-15-smoke.md","size":38}` |
| 2 | `GET /api/status` 路由缺失 | 补路由与复合探针 handler（`src/surfaces/http.ts:106`） | 冒烟 `status=200` 且含 `service:"dotd"` |
| 3 | CP 的 `lowBrain` 未接线 | 惰性 holder + MR 就位后回填（`src/daemon.ts:474-507`） | 冒烟事件匹配建任务（light 轨真实被调） |
| 4 | `scheduler.start()` 从未被调用（recoverOnStartup 只做恢复不起定时器，`src/control-plane/recovery.ts:170-203`） | 归装配层 CP §7.1 步骤 7（`src/daemon.ts:658`） | 装配测试断言「恢复后 scheduler 已启动」 |
| 5 | SSE 重放快照 provider 未注入（SF 已申报「需 daemon 装配层补一行」） | 惰性 holder 注入 approvals/queue 两通道（`src/daemon.ts:401-424`），`:528`/`:574` 回填 | `tests/surfaces-sse.test.ts` 20/20；当时全量 807/807，2026-10-17 复跑 935/935 |

另有两处**非代码**修复：

- `tests/control-plane-queue.test.ts:256` 的退避断言是时序脆弱的（等价于要求「finish 到断言之间耗时 < backoff 2s」），全量并发跑时会被同文件其他 test 拖过窗口而假失败（实测该测试在全量跑中耗时 7396ms、单文件跑仅 202ms）。已把参照时刻改为 `finish()` 之前的 `t0`，并用反向实验验证鉴别力未削弱（把 backoff 注入为 0 / -1000 时测试仍红）。**实现侧未改一字**（`src/control-plane/queue.ts` 与备份逐字节一致）。
- `dotd/web-ui/node_modules` 缺失导致 `npm run build:web` 必然报 TS2307/TS7026。按编排脚本授权（经 escalate 取得）安装 `web-ui/package.json` 已声明的依赖，**未改依赖清单**（仍 7 项）。

---

## 2. 三道门禁结果

以下全部为**本次会话实跑**，命令原样给出。

### 2.1 typecheck

```
$ cd dotd && node node_modules/typescript/bin/tsc --noEmit -p .
EXIT=0        （零输出）
```

口径说明：用 `node_modules/typescript/bin/tsc` 直跑而非 `npm run typecheck`，与 `package.json:16` 的 script 等价；执行面模块曾申报「npm run 形式在 cygwin 下 Zone Allocation OOM（EXIT=134，非类型错误）」与「npx 走网络代理 ECONNREFUSED」，故统一用二进制直跑。

### 2.2 test

阶段一收尾时（原文，807/807）：

```
$ cd dotd && node --disable-warning=ExperimentalWarning --import tsx --test "tests/*.test.ts"
ℹ tests 807
ℹ suites 67
ℹ pass 807
ℹ fail 0
ℹ duration_ms 172355.4089
```

**2026-10-17 复跑（飞书通道等合入后）**：

```
$ cd dotd && node --disable-warning=ExperimentalWarning --import tsx --test "tests/*.test.ts"
ℹ tests 935
ℹ suites 70
ℹ pass 935
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 180523.1411
```

`node:sqlite` 的 ExperimentalWarning 已用 `--disable-warning` 压掉；阶段一时连跑三轮稳定（第 1 轮曾偶发 1 个失败，根因是测试断言时序脆弱，见 §1.4，修后稳定）。

> **必须在 `dotd/` 目录下跑。** `tests/surfaces-cli.test.ts:370` 等三个文件用 `process.cwd()`
> 拼仓库内路径，在别处跑会得到 11 个 ENOENT 假失败（其余 39 个测试文件都用 `import.meta.url`，
> 不受影响）。`npm test` 的 glob 是 `tests/*.test.ts`，所以从仓库上层跑同样中招。

### 2.3 build:web + smoke

```
$ cd dotd && npm run build:web
> tsc --noEmit -p . && vite build
dist/index.html                   0.41 kB │ gzip:  0.30 kB
dist/assets/index-KMqoCVS4.css    6.29 kB │ gzip:  1.89 kB
dist/assets/index-DnRlOqeO.js   240.30 kB │ gzip: 74.82 kB
✓ built in 287ms
EXIT=0
```

```
$ cd "/c/Users/1/Documents/研究/toagi" && node dotd/scripts/smoke.mjs
[PASS] daemon 子进程存活并完成启动
[PASS] GET /api/status → 200 且含 service 字段 — status=200 body={"ok":true,"service":"dotd","dotId":"dot1",...}
[PASS] GET / → 200 且是 UI index.html — status=200 bytes=405
[PASS] UI 静态资源（JS/CSS）全部 200 — assets/index-DnRlOqeO.js=200 assets/index-KMqoCVS4.css=200
[PASS] POST /hooks/smoke → 202 {eventId} — status=202 body={"eventId":1,"dup":false}
[PASS] 事件匹配建任务（tk_ev_<eventId>） — eventId=1 taskId=tk_ev_1
[PASS] 任务到达终态 done — taskId=tk_ev_1 status=done
[PASS] journal 含至少一次工具步（fs.write 且 succeeded） — result={"path":"/dot/home/notes/2026-10-15-smoke.md","size":38}
[PASS] SIGTERM（IPC 触发，Windows 跨进程信号不可达）后 daemon 优雅退出（exitCode=0） — code=0 signal=null 用时 94ms
[PASS] 优雅停机标记落库（shutdown_marker） — "{\"shutdown_marker\":true}"
[PASS] OUTBOX.md 有优雅退出留痕 — bytes=43
冒烟结果：11/11 通过，退出码 0
```

冒烟脚本本身 **cwd 无关**（`scripts/smoke.mjs:39-40` 从 `import.meta.url` 推 repo 根，不读 `process.cwd()`），上面即从 repo 上层目录启动。它用临时数据目录 + stub 模型 + stub fleet，**绝不碰宿主真实 `~/.dotd`**（`ls -la ~/.dotd` 无输出，即宿主该目录根本不存在、未被创建也未被读写）。

### 2.4 汇总

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `node node_modules/typescript/bin/tsc --noEmit -p .` | `tc:0`（0 错误） |
| test | `node --disable-warning=ExperimentalWarning --import tsx --test "tests/*.test.ts"` | 阶段一 `ts:0`（0 失败 / 807 通过）；**2026-10-17 复跑 0 失败 / 935 通过**（45 文件 / 78 suites） |
| build:web | `npm run build:web` | `wb:0`（0 错误） |
| smoke | `node dotd/scripts/smoke.mjs` | `sm:0`（0 失败 / 11 通过，退出码 0） |

---

## 3. 与真实环境的差距

按「能不能在本机验证」分三类。**全部为实测结论，未验证的不冒充已验证。**

### 3.1 本机无 docker → stub fleet

- 现状：Windows 无 dockerd；WSL 侧虽有 daemon，但模块契约禁跨 WSL 调用。`DOTD_FLEET=stub` 时执行面走内存 stub，**不起容器、不发 docker 指令**（`src/exec/netguard.ts:115-116`：`applyRules` 在 `backend.kind !== 'docker'` 时直接 `return false`）。
- 后果：Playwright 容器、iptables `DOTD-OUT` 链、docker 卷 prune、容器状态机与真实 dockerd 的交互，**在本机一条都没验证过**。
- stub 的保真度：幂等语义与真实 ledger 对齐（同 `call_id` 第二次进入直接重放首次结果，`CONVENTIONS.md:155`）；但 stub 后端无 docker 卷列表，DiskGardener 的 prune 无主卷步骤退化为只回收在册但容器已销毁的卷（`src/exec/disk.ts:118-127`），freed 字节数用条目数近似。
- 需要真实环境首启时回归：容器 boot/recreate/destroy 状态机、`POST /fs/ops` 桥的真实 HTTP 往返、netguard 规则实装、uid 1001 降权（EX §7.1 Q7，本机无法验证）。

### 3.2 真实 OpenRouter 调用未在本环境跑过

- 现状：`src/router/transport.ts HttpTransport` 已实现，但测试一律用 StubTransport 或手写 fake，**零网络请求**；`DOTD_MODEL_TRANSPORT=stub` 是全部测试与冒烟的形态。
- 后果：真实供应商的 429/5xx/超时分类、`Retry-After` 软冷却、breaker 的 open→half_open 探活、候选端点切换，**只在 stub 与单测假 fake 上验证过**。
- 配置就绪度：`config/models.yml` 的 tier1 主端点现为 `base_url: http://127.0.0.1:7863/v1`（本机 workbuddy2api 容器，`api_key_env: WB2API_KEY`）——**阶段一原文写的 `https://openrouter.ai/api/v1` 已被替换**：2026-10-16 实测 OpenRouter 免费路由 ~40% 返回 200 无 choices 的空壳、付费模型区域封锁 403，故从 tier1 撤下改为 tier2 备胎（`enabled:false`）。**换供应商只改 base_url 行 + key_env**（`models.yml` 注释原文）；搭建方法与拿 key 的方式见 `docs/tier1-endpoint.md`。

### 3.3 设计目录树里的三个运维脚本仍未创建

`docs/design/自主Dot系统设计方案.md:403` 列的 `scripts/` 三项，实测仍未创建：

| 脚本 | 设计用途 | 现状 |
|---|---|---|
| `wsl-bootstrap.sh` | docker 组预检 | **未创建** |
| `portproxy.ps1` | Windows→WSL 端口代理 | **未创建** |
| `calibrate-watermark.sh` | 水位标定 | **未创建** |

但 `scripts/` 已从阶段一的「只有 `smoke.mjs`」长到 **17 个非临时脚本**（`tmp-*` 探针已于 2026-10-17 删除，删前逐字节备份到仓库外），且都不是设计列的那三个：
`smoke.mjs` / `daemon-launch.sh` / `dev-run.sh` / `setup-dev-env.sh` / `win-relay.mts` /
`wsl-build-image.mts` / `wsl-fleet-boot.mts` / `wsl-fleet-prep.sh` / `wsl-install-node24.sh` /
`wsl-pull-image.sh` / `ram-check.ps1` / `launch-olmoe.ps1` / `start-relay.ps1` /
`router-chain-probe.mts` / `init-config.mjs`。另有 17 个 `tmp-*` 一次性探针（写死内网 IP、
WSL 绝对路径，`.gitignore` 已挡，不入库）。

关于 `exec-image/Dockerfile`：**阶段一申报时确为缺口，2026-10-16 已补齐**（2626 字节）。
§3.1 的容器回归缺的不再是镜像文件，而是真实 dockerd 环境下的端到端跑测。

### 3.4 其他未验证项

- `jsonl_watch` 的文件轮询循环未接线（依赖 chokidar 不可用），默认 `enabled:false`；§5.3 的行规范化/dedup/旋转语义已在 `ingress.ts` 实现并有测试。
- Telegram 通道：阶段二项，接口已定型、`available` 恒 false。**email 通道：同上。飞书通道则已实装且是现役入站/出站通道**（见 §6）——原文此处把飞书漏掉了。
- 免费池：`config/free-models.yml` 的 `models: []` 为空（阶段一定位「池空但代码结构在位」），侦察源与求救闭环代码在位但无真实候选。
- 多 Dot：阶段一恒 `'dot1'`，无 `dots` 表（契约裁定）。
- 全部门禁均在 **stub 模型 + stub fleet** 下通过；真实模型/真实容器的组合跑法**一次都没有**。
- **首次起 daemon 会崩在配置上**（阶段一原文未记）：daemon 只读 `~/.dotd/config.yml`，仓库里的 `config/dotd.yml` 是模板且含三个严格展开占位（`DOTD_MASTER_TOKEN` / `DOTD_RO_TOKEN` / `HOOK_GRAFANA`），未设置即 `ConfigError` 拒启动。跨平台生成入口是 `npm run init-config`（见 §4.1）。

---

## 4. 明天怎么开始用

### 4.1 起 daemon（stub 模式，今天就能跑）

```bash
# 仓库根 = C:/Users/1/Documents/研究/toagi
cd dotd
npm run init-config      # 生成 ~/.dotd/config.yml + ~/.dotd/tokens.env（跨平台、幂等）
source ~/.dotd/tokens.env
npm run serve            # = node --import tsx src/daemon.ts
```

（`src/surfaces/cli.ts:156` 的 `serve` 子命令只打印引导提示，真入口是 `src/daemon.ts`。）

**关于配置文件（阶段一原文此处是错的，已修订）**：原文说「仓库 `config/` 下没有 surfaces 的
`config.yml`，参照 `scripts/smoke.mjs:71-100` 自写一份」。实际是：

- 仓库 `config/dotd.yml` 就是 surfaces 配置的**模板**（七节齐全），但 daemon **不读它**——
  daemon 只读 `~/.dotd/config.yml`（`src/surfaces/config.ts:354`），且只读其中的 `surfaces:` 一节；
- 模板里 `${DOTD_MASTER_TOKEN}` / `${DOTD_RO_TOKEN}` / `${HOOK_GRAFANA}` 走 `expandEnv`
  严格模式，未设置即 `ConfigError` 拒启动（`src/surfaces/config.ts:204-211`）；
- 所以**直接 `cp config/dotd.yml ~/.dotd/config.yml` 不够**，先生成 token 再让脚本替换占位。
  `npm run init-config` 就是干这个的（`scripts/init-config.mjs`）：随机生成三个密钥写进
  `tokens.env`，再由模板生成填好值的 `config.yml`；幂等，已存在的行一律不动。
- 原生 Windows 上用不了 bash 版的 `scripts/setup-dev-env.sh` / `dev-run.sh`，用这个 Node 脚本。

启动前的检查清单：

1. **配置文件**：默认读 `~/.dotd/config.yml`（或 `DOTD_CONFIG` 指定），surfaces 七节缺一不可，fail-closed。用 `npm run init-config` 生成。
2. **数据目录**：默认 `~/.dotd/`（`DOTD_HOME` 覆盖）。第一次起会建库并跑 **8 个迁移到 `user_version=70`**（`src/daemon.ts:413`）。
3. **模型 key**：tier1 是 `http://127.0.0.1:7863/v1` 的 workbuddy2api 容器，需要 `WB2API_KEY`；**这个 key 在本机没有任何持久来源**（不在 `tokens.env`、不在 Windows 环境变量，只在跑着的 daemon 进程环境里），重启就会丢，详见 `docs/tier1-endpoint.md`。
4. **Web UI**：`web-ui/dist/` 已在仓库内，daemon 会静态托管；`GET /` 应返回含 `<div id="root">` 的 index.html。

起来之后的用法（CLI 是 HTTP 瘦客户端，默认连 `127.0.0.1:7788`）：

```bash
npm --prefix dotd run dotd -- status                 # 队列 + 熔断 + 待批审批总览
npm --prefix dotd run dotd -- ask "帮我…"            # 发起主人对话（priority=1）
npm --prefix dotd run dotd -- approvals              # 待批列表
npm --prefix dotd run dotd -- approve 42             # 批准（once|remember）
npm --prefix dotd run dotd -- watch                  # 实时事件流（SSE）
npm --prefix dotd run dotd -- task tk_xxx            # 任务 + journal 步骤
```

浏览器开 `http://127.0.0.1:7788/`，登录页输 master token，即可用六视图。

### 4.2 环境变量总表

| 变量 | 作用 | 出处 |
|---|---|---|
| `DOTD_HOME` | 数据目录根（默认 `~/.dotd`） | `src/daemon.ts:107` |
| `DOTD_DB_PATH` | 库文件路径（优先于 `DOTD_HOME` 推导） | 契约 D1；`src/db/conn.ts` |
| `DOTD_CONFIG` | surfaces 的 `config.yml` 路径 | `src/daemon.ts:151` |
| `DOTD_CONFIG_DIR` | 仓库 `config/` 目录（默认 repo 内） | `src/daemon.ts:115` |
| `DOTD_WEB_ROOT` | web-ui 构建产物目录（默认 `web-ui/dist`） | `src/daemon.ts:121` |
| `DOTD_MODEL_TRANSPORT` | `=stub` 走内存 stub 模型，零网络请求 | `CONVENTIONS.md:154`；判据在 `src/daemon.ts:159` |
| `DOTD_FLEET` | `=stub` 走内存 stub fleet，不起容器 | `CONVENTIONS.md:155`；判据在 `src/daemon.ts:160` |
| `DOTD_MODEL_STUB_SCRIPT` | stub 模型的预置响应（JSON 数组，按 `endpointId × track` 回放，耗尽即抛） | `src/router/transport.ts:676-681` |
| `DOTD_MASTER_TOKEN` / `DOTD_RO_TOKEN` | `config/dotd.yml` 里的 token 占位符展开（严格模式，未设即拒启动） | `src/surfaces/config.ts:204-211` |
| `WB2API_KEY` | tier1 主端点 key（`http://127.0.0.1:7863/v1`，workbuddy2api 容器） | `config/models.yml`；拿法见 `docs/tier1-endpoint.md` |
| `OPENROUTER_API_KEY` / `BACKUP_API_KEY` | tier2 备胎 / tier1 备胎端点的 key（当前均 `enabled:false`） | `config/models.yml` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` / `FEISHU_OWNER_CHAT_ID` | 飞书通道（非严格展开，未设即空串 → 飞书不工作但不拒启动） | `src/surfaces/config.ts:338-342`；见 §6 |
| `DOTD_AGENT_RUNTIME_URL` / `DOTD_AGENT_RUNTIME_TOKEN` | fsops 桥基址与 token（**变量名为实现期自拟**，设计文档未定义） | 记忆系统模块申报 |

### 4.3 怎么把 stub 换成真实依赖

**换真实模型**（两步）：

1. 设好 key：`set OPENROUTER_API_KEY=sk-or-...`（或改 `config/models.yml:14-30` 指向别的供应商 + 对应 env）。
2. **不要设** `DOTD_MODEL_TRANSPORT`（或设为非 `stub` 的值）——`src/daemon.ts:157` 的判据是 `process.env.DOTD_MODEL_TRANSPORT === 'stub'`，缺省即真实路径。

**换真实容器**（三步）：

1. 镜像已在：`exec-image/Dockerfile`（2626 字节）按设计方案 §9.5 创建，构建走 `scripts/wsl-build-image.mts`。
2. 起 WSL 侧 dockerd（拓扑要求 daemon 与 dockerd 同在 WSL，经 `/var/run/docker.sock` 直连，设计方案:246）。
3. **不要设** `DOTD_FLEET`（缺省即真实 fleet）。netguard 的 iptables 链会真实执行。

**建议的切换顺序**：先只切模型（`DOTD_FLEET` 仍留 stub）→ 用 `npm run dotd -- watch` 看真实 route/breaker 行为 → 再补镜像切容器。两步分开，出问题好定位。

**回归时务必重跑**：`node dotd/scripts/smoke.mjs`（stub 形态，验证装配没被改坏）+ 真机首启时按 §3.1 清单逐项验容器。

---

## 5. 阶段二入口清单

按设计文档的阶段划分（`CONTEXT.md:52`：阶段二 = Telegram/邮件入口、低智能分流到本地模型、免费池+侦察+求救闭环、审批规则持久化）整理，每项给出门槛与当前状态：

| # | 入口项 | 当前状态 | 门槛 / 前置 |
|---|---|---|---|
| 1 | **Telegram 全量**（出站长轮询 + 入站 ingest + TG 审批双通道 + 卡片 edit 节流） | `src/surfaces/channels.ts` 只有 `TelegramGateway` 接口 + `NULL_TELEGRAM_GATEWAY` 占位（`available` 恒 false）；入站只有 normalize + 审批指令判别 | 需 bot_token + allowlist（`config/dotd.yml:68` 已有 telegram 节）；依赖 §5 项 2 的 `surf_tg_card_state` 表（050 迁移已建） |
| 2 | **email 通道**（SF 认领实现，阶段一 `available=false` 全走 OUTBOX） | 未实现 | SMTP_URL 配置；求救 SMTP 用原生或 nodemailer（设计方案:996，**新增依赖需先引设计文档出处**） |
| 3 | **免费池实接入**（Tier3 策展池 + 候选只读元数据 + 接入需主人批准） | `config/free-models.yml` 的 `models: []` 为空；`src/router/pool.ts` 解析器就绪 | 往 `models:` 加条目；每条要过「微型工具调用往返测试」并写 `last_verified`（MR §2.2） |
| 4 | **侦察闭环**（recon.scan，只用 `api.github.com` base64 与 `openrouter /models` 元数据，禁直连 github.com/huggingface.co） | `src/router/recon.ts` 结构在位，池空无候选 | 依赖项 3 的池；候选**绝不发推理请求**，接入必须主人批准（MR §4.6） |
| 5 | **求救闭环全通道**（telegram→email→OUTBOX，单通道 10s 超时换下一） | 阶段一 `channels=null` 全走 `~/.dotd/OUTBOX.md`；`alert_dispatch` 账本先行 + 24h 去重已实现 | 依赖项 1、2 |
| 6 | **低智能分流到本地模型**（7B 跑主循环） | 设计明确这是「B1 批准后的变体」，**不在阶段二默认范围**；当前 light 轨已由 tier2 承接 | 需主人批准变体 + 本地引擎（`models.yml:36/48` 两行已留位） |
| 7 | **审批规则持久化增强**（endpoint_grants 的 LRU 用 last_hit_at） | 当前因 DDL 无该列而退化为 id 序（治理模块已申报） | 需加列 → 改迁移 → **改 DDL 前必须先改设计文档**（DDL 一字不改是该模块的硬约束） |
| 8 | **JSONL 监听轮询循环** | `ingress.ts` 语义全实现，只缺文件轮询（chokidar 不可用） | 用 `fs.watch` 或定时 stat 自实现；或引入 chokidar（需先引设计文档出处） |
| 9 | **`exec-image/Dockerfile`** | **已创建**（2626 字节，2026-10-16） | 已不是缺口；剩下的是 §3.1 的真实 dockerd 端到端跑测 |
| 10 | **三个运维脚本**（`wsl-bootstrap.sh` / `portproxy.ps1` / `calibrate-watermark.sh`） | 不存在 | 按设计方案 §9.1 目录树补；真实部署的前置。注意 `scripts/` 现有 17 个非临时脚本均非这三项 |
| 11 | **crontabs 管理接口归口** | `heartbeat-tick.ts` 有 `createHeartbeatAdmin`（直写 CP 表），注释标明「SF 提供、CP 可替换」 | CP 补出 `addCrontab` 后改走端口，删掉 SF 侧直写 |
| 12 | **多 Dot** | 阶段一恒 `'dot1'`，无 `dots` 表（契约 D2 裁定） | 契约层面先解冻 `dots` 表 |
| 13 | **反检测增强** | 未实现 | 设计列为阶段二/三项 |
| 14 | **真实模型 + 真实容器组合回归** | 一次都没跑 | §3.1 + §3.2 全部前置完成后的第一件事 |

---

## 6. 飞书通道（2026-10-16/17 新增，阶段一原文完全未提）

这是阶段一之后最大的功能增量：**飞书已取代 Telegram 成为现役入站/出站通道**。
原文通篇没有提过一次飞书，而 Telegram 至今仍是 `available` 恒 false 的占位。

### 6.1 架构：WS 长连接入站，不需要公网地址

daemon 跑在 NAT 后（WSL，只听 `127.0.0.1`），没有公网回调地址。飞书开放平台支持
应用侧主动建立**出站 WebSocket**，事件从这条连接推下来——所以不需要公网 IP、
不需要 VPS 反代、不需要 verification token（鉴权由 app_id/app_secret 握手完成）。
选型理由与属主切分见 `src/surfaces/feishu-ws.ts:1-21` 头注原文（2026-10-16 主人拍板）。

| 文件 | 大小 | 职责 |
|---|---|---|
| `src/surfaces/feishu-ws.ts` | 5383 B | 官方 `WSClient` 长连接入站；把扁平帧重组回 v2.0 信封再进 classify |
| `src/surfaces/feishu-inbound.ts` | 14943 B | `classifyFeishuInbound` + `handleFeishuCallback`（去重 / 主人闸门 / fail-closed） |
| `src/surfaces/feishu-outbound.ts` | 5149 B | 出站回路：feishu 来源任务终态 → 回复发回原会话 |

装配点：`src/daemon.ts:694-704`（appId 与 appSecret 均非空才建 `FeishuGateway`）、
`:723`（起 WS 入站）、`:738-739`（起出站回路）。两个 key 有一个为空就**不启动**该通道，
但**不拒 daemon 启动**——这是静默失效，配置错了不会报错，只是飞书不理你。

WS 与 HTTP webhook（`/hooks/feishu`）共享同一条任务链，去重、主人闸门、fail-closed
语义完全一致；区别只在 payload 形状（WS 扁平 vs HTTP v2.0 信封）。

### 6.2 配置

`config/dotd.yml` 的 `surfaces.feishu` 一节（2026-10-17 由本文件修订时补进仓库模板）：

| 键 | 展开方式 | 说明 |
|---|---|---|
| `app_id` / `app_secret` | 非严格 | 均非空才启用通道 |
| `verification_token` / `encrypt_key` | 非严格 | WS 模式下用不到，留空即可 |
| `owner_chat_id` | 非严格 | 逗号分隔支持多会话；留空 = 只入站不出站 |
| `edit_throttle_ms` | — | 出站编辑节流，默认 1200 |

密钥与 `http.master_token` 同源，一起落在 `~/.dotd/tokens.env`，由
`scripts/init-config.mjs` 或 `scripts/setup-dev-env.sh` 生成。**注意
`setup-dev-env.sh` 不生成飞书那几个键**（bash 版停在阶段一），用 `npm run init-config`。

### 6.3 验证到什么程度

- `tests/surfaces-feishu-inbound.test.ts` + `tests/surfaces-feishu-outbound.test.ts`
  共 **35 个用例，全部通过**（本次实跑：`node --import tsx --test` 两文件 → tests 35 / pass 35 / fail 0）。
- 迁移：`db/migrations/060_feishu_channel.sql`、`070_inbound_seen.sql`（这也是
  §1.2 里迁移包从 6 个变 8 个的原因）。
- **未验证**：与飞书开放平台的真实 WS 连通（需要真 app_id/app_secret 与网络出口）。
  WSL 部署的 win-tcp-relay 注意事项见 `README.md`「WSL 部署」一节。

---

- 所有 `path:line` 均可在仓库中直接跳到对应位置。
- 所有命令与输出均为本次会话实跑；凡写「未验证」的，即本次没有跑过、也没有找到可推断的证据。
- 各模块偏差一节**逐字收录写手申报**，未做改写；对申报中已被本次整合解决的部分，用 ✅ 标注并给出解决证据，但保留原文以便追溯。
- 语义争议的仲裁源：`docs/design/`（`CONVENTIONS.md` 同）。
- **2026-10-17 修订的边界**：本文开头的修订表与正文中带「2026-10-17」标注的段落是本次
  逐条 `ls`/`grep`/实跑核对后改的；未标注的段落仍是阶段一原文，其中的数字与「不存在」
  类结论**可能已过期**。引用前请自行复核。
- 相关文档：`README.md`（对外门户，含已知问题全清单）、`docs/tier1-endpoint.md`
  （tier1 端点搭建与 `WB2API_KEY`）、`CONVENTIONS.md`（工程约定）。

## 7. 模型级 fallback 链（2026-10-17 迁移自 PilotDeck）

阶段一原文完全没有这一层：路由的容灾只有**端点级**——`pickCandidates()` 按 tier1→2→3→4
单向降级，一个端点坏了就换下一个端点。而 primary 轨长期只有一个候选（tier1 的
hy3/workbuddy2api 代理），端点内没有第二手，一次模型限流就把唯一候选打进熔断，
之后每个交互任务直接失败。本次把 PilotDeck 的 `runFallbackChain` 迁移进来，补上
「端点内换模型」这一层，并连同它最要紧的那条不变量：**模型级失败不连坐端点熔断**。

### 7.1 攻击的真实病灶

记忆 `dotd-model-layer-live-state` 记的现状：primary 轨只有一个候选，OpenRouter 一死
全线交互任务停。同一份记忆还记了 OpenRouter 免费路由实测 ~40% 返 200 无 choices 的
空壳（Nvidia 免费池过载）——注意这种故障的凭据和端点**都是好的**，坏的只是那一个
模型/那一条路由。把它记到端点熔断窗口上，等于让一个坏模型杀死整个端点。

### 7.2 语义（三层，缺一不可）

| 层 | 判据 | 动作 |
|---|---|---|
| 模型级 | `isModelScopedKind`：`rate_limit` / `quota` / `server_error` / `timeout` / `network` / `bad_protocol` | 记 tried + `model_call_log`，**不结算熔断**，换同端点下一个模型 |
| 链尾 | 链上最后一个模型也失败 | 记账（带 model）+ 结算熔断，换下一个端点 |
| 端点级 | `auth` / `engine_unavailable` / `pool_unverified` | 立刻收手：不烧剩下模型，记账 + 结算熔断，换下一个端点 |

`isModelScopedKind` 的判据是「故障是否与单个模型绑定」。鉴权（401/403）是同端点所有
模型一起挂，本地引擎不可用与池无资格同理——这三种靠换模型救不回来，继续试只是白烧。

### 7.3 流式的额外约束：只在首字节前降级

§4.7 的分界点在流式路径上仍然成立且更硬：**首字节之后模型锁定**。已经向调用方吐过
字节了，此时换模型重发就是重复执行，直接违反 journal 的「绝不重复执行」。所以
`stream()` 的链循环只包住「开流 + 收到首字节」那一段；首字节后断流仍抛
`StreamInterruptedError` 交调用方裁决，与迁移前逐字一致。

### 7.4 配置面

```yaml
endpoints:
  - id: openrouter-main
    models: { primary: hy3, light: hy3 }
    fallback_models: { primary: [hy3-alias-2, hy3-alias-3], light: [hy3] }
```

- 新增键 `fallback_models`，与 `models` 平级，**可选**。不配 = 单元素链 = 迁移前行为逐字等价，老配置零改动。
- 每条链上限 `MAX_FALLBACK_MODELS = 5`（与 PilotDeck `LITELLM_ROUTER_MAX_FALLBACKS` 同值）。链再长通常已是供应商整体故障，那该换端点解决。
- **只支持行内数组**。YAML 块列表（`- a` 逐行）在本仓库的极简解析器里会被静默丢弃——写成块列表等于没配且不报错，`config/models.yml` 的说明块把这点写明了。
- 固化时做形状消毒（去重 / 去空串 / 截断到 5，`config.ts sanitizeFallbackModels`）；与主模型重名的那条留给 `modelChain()` 去重（固化时看不到 `models`，两层各管一层）。
- fail-loud：给端点不服务的轨配备份（`fallback_models.light` 而 `models.light` 不存在）→ `ConfigError`，daemon 拒启动。死配置不静默放行。

### 7.5 改动清单

| 文件 | 改了什么 |
|---|---|
| `src/shared/contracts.ts:402` | `EndpointDef.fallbackModels?: Partial<Record<Track, string[]>>`；`TryRecord.model?: string`（:522）——同端点多条尝试靠它才分得清是谁挂的 |
| `src/router/candidates.ts:35/48/66` | `MAX_FALLBACK_MODELS`、`isModelScopedKind`、`modelChain` 三个纯函数 |
| `src/router/config.ts:234/598/709/752` | `inlineListMap`（数组值不被 JSON.stringify 成文本）、`fallback_models` 解析分支、`sanitizeFallbackModels`、`validateModelsConfig` 的备份轨校验 |
| `src/router/ModelRouter.ts:858/1007` | `runModelChain`（非流式链循环）、`noteModelFail`（记账但不入窗）；`noteFail` 增加 `model` 形参——链尾失败也记真正失败的那个模型，否则 `model_call_log.model` 回落成主模型，账就串了 |
| `src/router/ModelRouter.ts:646` | `stream()` 的链循环，只包住首字节前那一段 |
| `src/router/transport.ts:148/242` | `StubTransport` 脚本键从「端点 × 轨」扩成「端点 × 轨 × 模型」，否则同一端点上的链没法逐条回放。未配 `model` 的老脚本行为逐字不变 |
| `config/models.yml` | `openrouter-main` 处写全语义与写法的说明块（示例注释掉：没实测过 hy3 别名稳定性之前不填）；`backup-openai-compatible` 给了一个行内实例 |
| `tests/router-model-fallback.test.ts` | 新增 21 个用例 |

### 7.6 测试与门禁

- `tests/router-model-fallback.test.ts`：**21 个用例全绿**。覆盖链序、上限、去重、`isModelScopedKind` 判据表、主模型 429 换备用不换端点、`tried`/`model_call_log` 逐模型对账、4 次连续模型级失败后熔断器仍 closed 且 `consecFailures=0`、整链试完才换端点（且 `consecFailures=1` 而非 3——一次失败一次入窗）、auth 立即收手不烧链尾、light 轨独立成链、流式首字节前降级、流式首字节后断流绝不重放（`consumed=1` 即没重放）、配置解析与 fail-loud。
- 全量：`node --import tsx --test "tests/*.test.ts"` → **tests 905 / pass 905 / fail 0**。
- `npm run typecheck` → EXIT 0。

### 7.7 迁移过程中发现并修掉的两个真问题

1. **双重记账**：`runModelChain` 内部已按模型完成记账，外层 `complete()` 的 `catch` 又调了一次 `noteFail`——一次失败产出两条 `tried`、两次熔断结算、两行日志，把窗口比例污染成一倍。两处外层 `catch` 已缩成裸 `continue` 并注明原因。
2. **链尾失败记错模型**（测试逼出来的）：`noteFail` 原先不带 `model`，链尾那次失败落库时 `model` 回落成主模型——`model_call_log` 会把 model-c 的失败记成 model-a 的账。已加形参并在两处链调用点传入。

### 7.8 边界与未验证

- 迁移的是**设计与语义**，不是代码。PilotDeck 是 AGPL-3.0，逐字照抄有 copyleft 风险；dotd 的熔断器、mode 机、journal 契约都是自己的一套，链路只是形状相似。
- 本机 hy3 代理的别名清单与各自稳定性**未实测**，所以 `config/models.yml` 里的示例是注释掉的。要真用起来，先 `curl /v1/models` 拿别名，再按实测稳定性排序填进去。
- 链只在**同一端点内**有效。跨端点（换 base_url / 换凭据）仍是原来的 tier 降级，两者叠加而不是替代。

## 8. 补齐分发缺口时发现并修掉的两个真问题（2026-10-17 晚）

这一节记录的是把 `dotd-design/` 收进仓库、压缩快速开始、给 README 补截图的过程中**实测撞见**的缺陷——都不是文档笔误，是代码和配置真错了。

### 8.1 `npm test` 曾经是个假绿（一个引号，零用例执行）

`package.json` 里写的是 `node --import tsx --test "tests/*.test.ts"`。引号让 glob **不展开**，`--test` 收到一个字面量文件名 `tests/*.test.ts`，找不到文件 → 不报错、不执行 → `tests 0 / pass 0 / fail 0`，exit **0**。

也就是说在修好之前，`npm test` 对任何人都是"全绿"，包括 CI。已改成无引号形式（`tests/*.test.ts`），并加 `--test-concurrency=1`。

### 8.2 并行跑有 3 个假红（并发污染，不是代码错）

`node --test` 默认按文件并行。并行跑全量时 `tests/router-health.test.ts` 有 3 个用例稳定失败（`cooldownRemainingMs` 读到 0，期望 7500）；单独跑该文件 25/25 全过，`--test-concurrency=1` 串行跑全量也全过。复现过独立探针：同样的 settle 序列在全新 db 上 `remaining = 7500 / factor = 0.5` 完全符合断言。

结论是 runner 并发下的共享状态污染，**不是 `Breaker`/`HealthTracker` 的缺陷**（已用逐字复刻 + 独立 db 双重验证）。修法是把 `npm test` 固定为串行，让新人不会撞上同一批假失败。

### 8.3 CLI 入口守卫在中文路径下恒假（每个 README CLI 示例都曾静默无操作）

`src/surfaces/cli.ts` 的入口判据原来是：

```ts
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1].replace(/\/g, '/')}`) {
```

`import.meta.url` 会把非 ASCII 路径段**百分号编码**（`file:///C:/.../%E7%A0%94%E7%A9%B6/...`），手拼的字符串不编码。本机路径含"研究"二字，两者永不相等 → 守卫恒假 → `node src/surfaces/cli.ts status` 静默退出、exit 0、无任何输出。**README 里每一条 `npm run dotd -- xxx` 示例都因此是空操作。**

已改为与 `src/daemon.ts:835` 同一手法（比对解析后的绝对路径）：

```ts
const HERE = dirname(fileURLToPath(import.meta.url));
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  return resolve(argv1) === resolve(HERE, 'cli.ts');
}
```

修复后 `node --import tsx src/surfaces/cli.ts --help` 正常列出 15 个子命令，`status` 会真的去连 daemon 并打印结果。

### 8.4 顺带记下的两件环境事实（不是缺陷，但会咬人）

1. **第二个 daemon 实例不会消费队列**：用 `DOTD_CONFIG` 指向另一份配置在 `:7799` 起 daemon，`GET /api/status` 正常、能提交任务，但任务永远停在 `queued`——exec 层启动时把 dot1 标成 `quarantined`（日志：`[exec] boot 告警：dot1 进入 quarantined`），没有消费者。截图因此不能用"另起一个干净 daemon"的办法，只能在真跑着的 daemon 上截。
2. **同一台机器上可能跑着旧版 daemon**：`~/.dotd/daemon.log` 里出现过 `库已是最新（user_version=50）`，而仓库迁移已到 70、库内实测 90。旧进程读同一个库、重复领旧任务、不领新任务。看到"任务不动"先查这条，别急着改代码。
