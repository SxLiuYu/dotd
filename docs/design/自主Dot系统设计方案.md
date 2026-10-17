# 自主 Dot 系统（dotd）设计方案

> **本文是什么**：阶段一动工依据的唯一交付文档。由总编依据以下七份源文件编成：`dotd-design/CONTEXT.md`（下称 CT，优先级最高）、`modules/接缝契约.md`（下称"契约"，模块间一致性的唯一仲裁）、以及六份模块详设 rev2：`control-plane.md`（CP）、`model-router.md`（MR）、`governance.md`（GOV）、`execution.md`（EX）、`memory.md`（MEM）、`surfaces.md`（SF）。
> **冲突口径**：模块文档磁盘稿与接缝契约矛盾之处，一律以契约为准并已在文中标注（各模块的"待改清单"见契约 §10，磁盘稿尚未逐行回改，读原文时注意）。
> **本文第 9.2 节的合并 DDL 已实测**：2026-10-14 在本机 WSL Ubuntu-24.04 用 `sqlite3` 3.45.1 逐包执行通过——`DDL_OK`、`sqlite_master` 计 40（39 张业务表 + AUTOINCREMENT 自动建的 `sqlite_sequence`）、`PRAGMA integrity_check` 返回 `ok`，无报错。其余内容均为设计文本，尚未实现。

---

## 1. 系统总览与设计原则

### 1.1 目标与优先级（CT §目标）

自研类 OpenAI Dots 的**常驻个人 AI Agent 系统**，诉求按优先级：

1. **完全自主**：会话、记忆、任务队列、执行环境全部自持有，零商业托管；唯一外部依赖 = 模型 API，`base_url` 热切换，换供应商改一行配置。
2. **好用**：日用级交互体验，不做玩具。
3. **模型层自主容灾**：配置内模型全灭 → 自动降级 → 探测策展免费池 → 侦察互联网候选（只侦察不接入，接入必须主人批准）→ 全程发求救消息。

### 1.2 设计原则（从 CT 与各模块推导的公共纪律）

| # | 原则 | 落点 |
|---|---|---|
| P1 | **单进程 daemon + 单库** | Node 24 TypeScript daemon 跑 WSL 内（CT:18/34）；全系统一条 better-sqlite3 连接、一个库文件 `~/.dotd/dotd.db`、`WAL + synchronous=FULL + busy_timeout=5000`；CLI 只走 HTTP 不直写库（契约 D1/D2） |
| P2 | **崩溃安全优先于吞吐** | 步骤级 journal + `call_id` 幂等对账 + epoch 围栏：已落盘结果绝不重放、未知副作用绝不自动重执行（CT:44、CP §5、EX §5.4）；求救"账本先行"（MR §4.5）；心跳"先推进后投递"（SF §5.4） |
| P3 | **单一事实源，属主唯一** | 每表有唯一属主（契约 D4）；审批权威在 GOV、事件/任务权威在 CP、路由状态只经 `snapshot()` 读、会话历史属 MEM；不建跨模块所有权外键，一律 TEXT 弱引用（契约 D2 铁律） |
| P4 | **白名单制安全默认** | 工具未登记即 deny（GOV）；副作用未标注按 `unknown`（契约 J2）；登录态字段缺失 fail-closed 按登录态（契约 G1）；侦察候选永不自动接入（CT:11） |
| P5 | **与既有负载共存，不假设独占** | 与 netfuzz ~20GB 负载共存：四级内存水位背压 + 相对基线标定（CP §6.3）、容器硬配额禁 swap + OomScoreAdj=700 让位（EX §4）、本地引擎按"尽力而为"设计三道闸快速放弃（MR §4.1） |
| P6 | **盘小纪律** | journal blob 截断、各表 TTL/归档上限、镜像全局唯一 + ReadonlyRootfs、审计归档 200MB 封顶、db 软限 500MB（CP §5.4/§6.5、EX §8、GOV §6.2、MEM §6.2） |
| P7 | **术语逐字统一** | 以契约 §9 术语表为准：步身份 `call_id`、事件表 `events`、挂起等模型 = `paused(stop_reason='circuit_open')`（作废 `waiting_model`）、审批八态归 GOV、唯一 HTTP 监听 `127.0.0.1:7788`（作废 CP 的 8642）、Dot 占位 `'dot1'` |

### 1.3 模块图（ASCII）

```
                         Windows 10 宿主（无 docker）
   浏览器/CLI ── portproxy(netsh) ──┐
                                    ▼
        ┌──────────────── WSL Ubuntu-24.04 ────────────────┐
        │   dotd-daemon（Node 24，单进程 · 单 event loop）  │
        │                                                   │
        │  ┌─────────────────────────────────────────────┐  │
        │  │ 交互面 surfaces（SF）                        │  │
        │  │  唯一 HTTP 监听 127.0.0.1:7788              │  │
        │  │  Web UI(聊天/审批卡片/队列/熔断) · CLI       │  │
        │  │  SSE 总线(bus_seq 游标) · TG bot(阶段二)     │  │
        │  │  事件入口: webhook / JSONL 监听 / (email二)  │  │
        │  └───────┬───────────────┬─────────────────────┘  │
        │   ingestEvent/submit  gov.decide()  Notification-  │
        │        │                ▲          Channels 适配器 │
        │  ┌─────▼──────────────┐ │      ┌─────────────────┐ │
        │  │ 控制面 CP           │ │      │ 治理 GOV        │ │
        │  │ 队列+journal+调度器 │◄┼──────│ 工具分级·审批8态│ │
        │  │ (全系统 cron 唯一   │ │      │ 前后审查·审计   │ │
        │  │  宿主 register-    │ │      │ quarantine 表   │ │
        │  │  InternalJob)      │ │      │ spend 台账      │ │
        │  │ 事件→目标匹配      │ │      └───────┬─────────┘ │
        │  └──┬───────┬─────────┘ │   evaluate/  │hooks      │
        │     │       │           │  setAwaiting │           │
        │  ┌──▼───┐ ┌─▼────────┐  │ onApproval-  │           │
        │  │记忆  │ │模型路由  │  │ Settled      │           │
        │  │MEM   │ │MR        │◄─┴── complete(  │           │
        │  │两层: │ │熔断·降级 │  │  track)      │           │
        │  │文件+ │ │·免费池   │  └──────┬───────┘           │
        │  │SQLite│ │·侦察·求救 │        │ tier1 OpenRouter   │
        │  └──┬───┘ └──────────┘         │ tier2 Colibrì:8001│
        │     │ /fs/ops 桥               │      Ollama:11434 │
        │  ┌──▼──────────────────────┐   │      tier3 池/4 候选│
        │  │ 执行面 EX（dockerode）   │   └──► 外部模型 API    │
        │  │ 状态机·幂等 ledger 消费  │                        │
        │  │ HostNetGuard(iptables)  │  ~/.dotd/dotd.db 单库  │
        │  └──┬─────────────────────┘  ~/.dotd/OUTBOX.md 兜底 │
        └─────┼────────────────────────────────────────────────┘
              │ unix /var/run/docker.sock · bridge net "dotd"(ICC off)
        ┌─────▼──────────────────────────────┐
        │ 容器 dot-dot1（每 Dot 一台"电脑"）  │
        │  agent-runtime :9223 (Bearer token) │
        │  Playwright+stealth · Xvfb :99      │
        │  卷: dot1-home /dot/home            │
        │      dot1-profiles /dot/profiles    │
        │      dot1-state /opt/agent-state    │
        │      token ro-bind /run/dotd/token  │
        └────────────────────────────────────┘
```

数据面一句话：**事件从 SF 进、任务在 CP 排、模型问 MR 要、权限找 GOV 批、活由 EX 容器干、记忆 MEM 两头管**；全链路时序定稿见契约 §8（本文第 8 章走查）。

### 1.4 表所有权速览（契约 D4 唯一权威）

| 属主 | 表（阶段一全量 39 张，DDL 见 §9.2） |
|---|---|
| CP | tasks · task_results · steps · event_decisions · resource_events · events · crontabs |
| MR | breaker_state · breaker_sample · breaker_event · router_state · pool_probe_result · recon_candidate · alert_dispatch · model_call_log |
| GOV | approvals · decisions · approval_rules · endpoint_grants · quarantines · audit_log · audit_archive · spend_ledger · gov_seq |
| EX | exec_dots · image_builds · containers · exec_identities · exec_volumes · exec_calls · exec_disk_policy |
| MEM | mem_threads · mem_messages · mem_files_index · mem_maintenance_state |
| SF | surf_jsonl_offset · surf_tg_card_state · surf_ingress_rejects · surf_sse_cursor |

> 契约裁定：**阶段一不建 `dots` 表**（六份 rev2 均未建，MR/CP 曾引用它）——`dot_id` 一律 TEXT 弱引用、MVP 恒 `'dot1'`。契约 :35 的"dot 主档（配额、身份表等）列阶段三"指的是**多 Dot 主档表 `dots`**（配额分桶、跨 Dot 身份路由）；**EX 自有的单 Dot 身份映射表 `exec_identities` 属阶段一交付**——EX rev2 §9（execution.md:457-465）已建、§10 提供登记接口 `ExecService.setIdentityProfile(dotId, identityKey)→{profileHash}`（execution.md:542）、S5 要求登录态审计落 `exec_identities.identity_key` 名（execution.md:564），且验收锚①与 D8 恒 approve 用例都依赖它；契约 §10 待改清单未曾作废该表（本文合并审读对契约 :35 措辞的范围界定，登记于 §11.2 D6 供仲裁复核；首登通道另见 B16）。`surf_heartbeat_state` 独立表亦作废，行为扩展列并入 `crontabs` 单表（契约 H1）。

---

## 2. 模块一：控制面与任务队列（control-plane）

> 原文：`modules/control-plane.md`（rev2，13 条评审响应）。职责边界：拥有队列/journal/调度/背压地基，**不实现** LLM↔工具主循环（Runner 协程）、不拥有审批与事件入口。

**核心决策**

1. **进程模型**：单 OS 进程、零 worker；Runner 是同进程 async 协程，靠 `AbortSignal` 停（协程无法 SIGSTOP）；SQLite 同步写走唯一 event loop，写 journal 微秒级。优雅关停 SIGTERM → 停投递 → 协程步边界落 journal → `shutdownGraceMs=30s` 兜底强退，交恢复兜底（CP §2.1）。
2. **epoch 围栏**：任务每次转 `running` 令 `run_epoch+=1`；Runner 所有回写（heartbeat/endTool/finish/bindSession）必带 epoch，UPDATE `WHERE run_epoch=?` 行数 0 → 判"僵尸 Runner"拒绝并记 `stale_writer`。这条围栏根治"看门狗回收后旧协程迟写破坏数据"与"双 Runner 并发"（CP §2.2）。
3. **任务状态机**：7 态（queued/running/awaiting_approval/paused/done/failed/cancelled）。三条硬门控：进 running 只经 `pop()`（受 maxRunning + 背压∈{normal,guarded} 门控）；审批放行回 **queued**（带 `resume_from_seq`、priority≤2）而非直入 running；孤儿判定只认 `started` 步，`pending`（待审批）步不是孤儿（CP §4.1）。**pop 谓词定稿**（逐字恢复 CP §4.2:247-254，MVP 值 `cfg.maxRunningTasks=1`，CP §2.2:64）：

   ```sql
   -- 单写者事务内（BEGIN IMMEDIATE）：
   if (runningCount(dotId) >= cfg.maxRunningTasks) return null;   -- MVP: maxRunningTasks=1
   SELECT * FROM tasks
    WHERE dot_id=? AND status='queued' AND (run_at IS NULL OR run_at<=now)   -- 未到 run_at 的定时任务不可领
    ORDER BY priority ASC, COALESCE(run_at, created_at) ASC,
             resume_from_seq IS NOT NULL DESC                                -- 审批放行续跑任务插队到同键首位
   LIMIT 1;  -- 命中行：UPDATE … status='running', run_epoch=run_epoch+1
   ```

   语义注记（本次读者意见 F4 的定稿口径）：① **到期门**——`run_at > now` 的定时任务绝不提前领取，未到点就停在 queued（与 D-1 推演措辞统一：到期后同 queued 排队、受同一 ORDER BY 调度）；② **NULL 排序**——`resume_from_seq IS NOT NULL` 求值为 0/1，`DESC` 即"非 NULL（续跑任务）排前"，SQLite 无 NULL 排序歧义；③ 三道门（背压、maxRunning、`run_epoch+=1`）都在领取事务内强制，`idx_tasks_pop(dot_id,status,priority,run_at)` 服务此查询。
4. **步骤级 journal**：唯一写 `steps` 路径。工具步两步协议 `beginTool(=call_sent)→endTool(=call_done)`，`call_id`（ULID）先落库后调用；LLM 步 `beginLlm→endLlm` 只存 digest，**全量文本恢复责任在记忆模块**（契约 J1/J3、CP §7.3）。恢复三分流按副作用档：`safe/replayable` 重放；`unknown` 先向执行面 `reconcileCall(callId)` 对账——done 补记不重放、aborted 安全重放、仍未知→注入"结果未知"提示 + `forceApproval(kind='side_effect_unknown')` 转人工（CP §5.3）。
5. **事件→目标匹配**：消费 `events` 未决策行，规则层（`event-rules.yml`，via=rule 置信 1.0）优先，模型层走 `complete({track:'light', deadlineMs:15000, attemptId:'nonj:…'})`；**"建任务+写 event_decisions 同一 `BEGIN IMMEDIATE` 事务"，task 主键 `tk_ev_<events.id>` 确定性派生**——崩溃重放撞 PK 回滚，绝不双建（CP §6.1，幂等核心修复）。置信度分档：≥0.85 直接执行；0.55–0.85 执行+可撤销通知；<0.55 落 `inbox` 等主人（CP §6.2）。
6. **统一调度器**：`registerInternalJob(spec)` 是**全系统周期任务唯一宿主**（契约 J4）：治理 expirePending/compactAudit、路由四个 cron、queue.gc、heartbeat.tick、记忆两个维护 job 全挂这里；light job 在 throttled/halted 跳轮、heavy 照跑。
7. **四级内存背压**：normal/guarded/throttled/halted，阈值**首启自动基线标定**（采样 30min MemAvailable 的 p50=base，四档相对 base），未标定前兜底固定值 normal≥10/guarded 6–10/throttled 3–6/halted<3GB；throttled 只 pause **无在途调用**的容器（判据 `getContainerStats.hasInflightCall`）、必须有 unpause 解冻路径；halted 对协程 abort+任务 `paused(watermark)`，水位回升批量回 queued（CP §6.3）。
8. **队列上限**：`maxQueued=200`；满时只对**自动生成**任务先试 merge 再淘汰（主人手动任务 priority=1 永不清退），淘汰记 `queue_evict`（CP §4.4）。
9. **重启恢复序列**（HTTP listen 前）：迁移检查（失败→拒启动+写 OUTBOX）→ 在途任务 resolveOpenStep 归置回 queued → awaiting_approval/paused 原样保留、查治理 approvals 当前态走审批续跑 → 心跳 catchup → 重放未决策事件 → guard 标定 → scheduler.start（CP §7.1）。
10. **磁盘回收**：blob >32KB 外置文件；终态任务 steps/decision 30 天清理、骨架 180 天；VACUUM 保 dotd.db < 500MB（CP §5.4/§6.5）。

**关键接口定稿**（本次读者意见 F5：动工者需要可直接转 TS 类型的完整参数表。逐字段恢复契约 E2:99-103 与 CP §8:522-568 原文，合并校正；`ingestEvent`/`submit` 签名以**契约 E2 为准**，CP 磁盘稿 :524 的 `sourceEventLogId` 旧名作废）：

```ts
// —— 投递面（唯一两个机器入口，契约 E2/SF §1）——
ingestEvent(e: { source: 'http'|'file'|'heartbeat'|'telegram'|'email';   // email 枚举预留，阶段二接通
                 dotId: string; actor: string; payload: unknown;
                 dedupKey?: string; priority?: number })
  : { eventId: number; dup: boolean }            // 撞 events.dedup_key UNIQUE 幂等返回旧 id
submit(req: { title: string; goal: string;        // goal 必填：进 mem_messages 首条与上下文装配
              priority?: number;                  // 缺省 5；interactive=1/heartbeat·hook=5/bulk=7（SF §5.1 映射表，CP 不自定档位）
              runAt?: number;                     // epoch ms；NULL=立即可领；非 NULL 到点前 pop 不可见（§2 决策 3 到期门）
              dotId?: string;                     // 缺省 'dot1'
              threadId?: string;                  // 对话任务由 SF 先 memory.openThread 再带上（契约 E2:110）
              payloadJson?: string;               // 结构化载荷，落 tasks.payload_json（契约 E2:112）。
                                                  // 阶段一唯一已定稿生产者 = MEM 维护任务，
                                                  // 内容 = CompactionJobSpec（MEM §5.1/§4.5，
                                                  // Runner 侧反序列化后执行）；其余任务可为 NULL
              eventId?: number })                 // 事件派生任务回链 events.id（弱引用）
  : Task

// —— 队列面 ——
pop(dotId?: string): Task | null                  // 仅 Runner；谓词与三道门见 §2 决策 3
heartbeat(taskId: string, epoch: number, usage?: { tokens: number })
  : { overBudget: boolean; aborted: boolean }     // 累加 usage_tokens、围栏校验、预算/看门狗 abort 返回位
finish(taskId: string, epoch: number, r: { ok: boolean; summary: string }): void
cancel(taskId: string, by: 'user'|'guard'|'watchdog'): void
resume(taskId: string): void                      // 主人手动 paused → queued
list(q: { status?: TaskStatus[]; dotId?: string; limit?: number }): Task[]   // SF skip_if_busy 即用此
getTask(id: string): Task | null
getJournal(taskId: string): Step[]

// —— journal（唯一写 steps 路径；契约 J1：call_id=ULID）——
journal.beginTool(taskId, epoch, tool, args, se: SideEffect) : { seq: number; callId: string }  // = call_sent
journal.markPending(taskId, epoch, seq, approvalId: number): void        // 待审批步（pending，非孤儿）
journal.endTool(taskId, epoch, seq, st: StepStatus, result?: string): void  // = call_done；UPDATE 行数 0 → 拒
journal.beginLlm(taskId, epoch, promptDigest: string) : { seq: number; callId: string }         // 契约 J1 补齐 LLM 步身份
journal.endLlm(taskId, epoch, seq, respDigest: string): void
journal.getStepByCallId(callId: string): Step | null                     // 治理/执行面反查
journal.reconcileAndResolve(taskId, seq): 'replayed'|'deferred'|'took_result'  // exec.interrupted 处置（§5.3 三分流）
journal.skipStep(taskId, epoch, seq): void        // 审批 deny/expired → 该步 skipped
journal.tail(taskId, n?): Step[]

// —— 会话/审批联动 ——
bindSession(taskId, epoch, { sessionId: string; threadId: string }): void  // Runner 首步回写（契约 M2）
setAwaitingApproval(taskId, epoch, approvalId: number): void  // running→awaiting_approval；approvalId 恒指 GOV approvals.id
onApprovalSettled(taskId, approvalId, ok: boolean, meta?: { note?: string; revoke?: boolean }): void  // GOV 落定后栈内调用（契约 J6）；ok→queued+resume_from_seq
pauseByReason(taskId, reason: 'circuit_open'|'watermark'|'budget'|'tool_risk'): void
pauseDotQueue(dotId) / resumeDotQueue(dotId): void              // 契约 G3（quarantine 承接）
taskImpact(): { queued_primary: number|null; running: number; held: number }  // snake_case 按契约 T2；注入 MR.load
registerInternalJob(spec: { name: string; kind: 'light'|'heavy';
                            cron?: string; everyMs?: number; run: () => Promise<void> }): void
onBus(handler, events?: BusEvent[]): void
  // BusEvent = 'task.state' | 'task.budget_exhausted' | 'guard.level' | 'event.undecided' | 'stale_writer'（CP §8 事件名清单）
retryMatch(eventId: number, m: Match): void       // 主人覆写决策（via='manual' UPSERT）
```

**对话提交序列**（契约 S-1:406，SF `POST /api/messages {text}` 的实现步骤，本次读者意见 F5"缺参数与 priority 填充方"的定稿）：① SF 调 `memory.openThread('dot1', {channel:'web'}, …)→{threadId}`；② `memory.appendMessage(threadId, {role:'user', kind:'text', content:text})`；③ `cp.submit({ title: text.slice(0,60), goal: text, threadId, priority: 1, dotId:'dot1' })`——**priority=1 由 SF 适配器按映射表填充**（interactive 档），CP 不自定；会话历史属主 MEM，SF 只转调（SF §5.2:218）。

**track 的定界**（F5 第二问：`submit(track='light')` 字样与 tasks 无 track 列的矛盾）：`Track='primary'|'light'` **不是任务属性、tasks 表无 track 列也不应有**——它是 MR 的路由侧打标：`trackForEvent` 前缀表（`routing.light_events`，MR §2:90-93）按事件类型前缀匹配 + Runner 调用点显式 `track` 参数决定。MEM 两个维护任务（`memory-compaction`/`memory-retention`）的 light 轨落法：事件/探测前缀 `memory.*` 进 light_events 表（契约 J4:196 与 MR §2:92 配置项）；任务本体经 `submit({title, goal, payloadJson:<CompactionJobSpec>})` 投递——**载荷通道唯一取 payloadJson**（契约 E2:113 明裁 MEM:219 的 title 前缀编码过渡方案作废，故 title 只是可读名、不承载解析语义）。契约 J4 说"重活经 submit 入队、track=light"但未定 task→Runner 调用点的打标载体；在 payloadJson 唯一通道下，与两份原文最兼容的实施读法 = Runner 见 `payload_json` 为 CompactionJobSpec 即以 `complete({track:'light', deadlineMs:60_000})` 走摘要步（MEM §4.5:213/220-221 的 light 轨与 60s 快速失败语义）——此读法已在 §11.2 D5 条如实登记为契约未裁的推导，非新设计。

**与原文档的已裁定差异（以契约为准）**：CP 磁盘稿的 `event_log/heartbeat_target` 措辞、`:8642` 监听、`completeLow/NoChannelAvailable/waiting_model`、`--memory=2g --cpus=2` 硬编码、"唯一 child_process 跑 docker stats" 等均作废——事件/cron 表名为 `events/crontabs`；CP 的 REST 子集由 SF 路由器进程内转调 CP 函数；熔断耗尽错误名 `AllEndpointsDownError/NoQualifiedPrimaryError`；容器配额唯一事实源 = `exec_dots.limits_json`（默认 1536MB/2000m）；docker stats 由 EX 经 dockerode 实现（契约 E1/H1/H2/T1/J5）。

---

## 3. 模块二：模型路由与容灾（ModelRouter）

> 原文：`modules/model-router.md`（rev2，17 条评审响应；含本机实测事实引用）。职责：四级降级阶梯路由、熔断、双轨、应急位、免费池、侦察提案、求救、调用记账。不管理任务队列、不做审批裁决、不管本地引擎进程生命周期。

**核心决策**

1. **四级阶梯**：Tier1 配置内主模型（OpenRouter 等，`models.yml` 的 `base_url` 一行可换 + 文件监听热加载）→ Tier2 本地（Colibrì :8001 / Ollama :11434，尽力而为）→ Tier3 策展免费池 `free-models.yml` → Tier4 互联网侦察候选。**失败永远单向降级（1→2→3→4），绝不向上涨档重试**，一次请求最多走一圈（MR §4.2）。
2. **熔断器**：每 `endpoint×track` 一个实例，状态持久化 `breaker_state`（重启不丢）。closed→open 判据：窗口失败率≥0.5（≥5 样本）或连败 3 或 auth/quota 立即；open 指数退避（60s 起、上限 1h、quota 起步 30min）到点半开，`half_open_ok≥2` 才回 closed。**429 软冷却**（Retry-After≤120s 不 open，`throttled_until` 跳过）；**auth 类不自动恢复**——半开只允许在配置 reload 后触发（MR §4.1）。半开并发裁决：同时只放 1 个探活，第 2..N 个 `half_open_busy_skip` 直接跳下一候选。
3. **双轨**：`track:'primary'|'light'`；事件类型经 `trackForEvent` 前缀表（`routing.light_events`，须含 `event.match`、`memory.*`）打标；light 轨 tier2 前置于 tier3、不受 emergencyEligible 过滤；**primary 轨默认拒绝 7B 本地降格**——LOCAL_FALLBACK 下 primary 挂起（= 任务 `paused(circuit_open)`），除非主人显式在 models.yml 给 tier2 写 `models.primary` 授权，且 `RouteMeta.degraded=true` 供治理加验（MR §4.3）。
4. **全局 mode 状态机**：NORMAL / LOCAL_FALLBACK / EMERGENCY / RESTRICTED / TOTAL_OUTAGE；mode 与 `emergencyActive` **同事务落库后广播** `router.mode_changed`。变差→`maybeSendHelp()`，变好→`sendRecovery()`（多行收敛合并通报）。
5. **Colibrì 三道闸**：health → warm（`/profile` 的 `expert_disk_s==0` + 150s 宽限期）→ 槽位信号量（`max_concurrency:1`，机器实测无 batching）；`queue_reject_ms=8000` 抢不到槽只跳过不入窗，**连续 busy 达 3 → 记 `engine_unavailable` 入窗强制降级**——"长期半死不活"必然触发 mode 重算而非窗口永远健康（MR §4.1/§4.2）。
6. **免费池资格**：两级测试——每 30min health + 微型工具往返（echo 工具两回合、判 JSON 参数合法），无新鲜合格证（24h 过期）的池模型不得承载 primary；`NoQualifiedPrimaryError` 的唯一抛出点=池候选全被合格证挡下且存在待批侦察候选（MR §4.4/§4.2）。
7. **求救账本先行**：`alert_dispatch` 是去重唯一账本，**任何投递前先 INSERT pending**，投后回写；崩溃对账 pending>2min 补投、再败标 lost；同签名 24h 静默、超 24h 未决→催救 `#N`。通道 telegram→email→OUTBOX，单通道 10s 超时换下一；**阶段一 channels=null，全走 `~/.dotd/OUTBOX.md`**（契约 T3 把 MR 原文的 `/dot/state/` 改一行配置），追加幂等 grep 签名段头。侦察源绕墙：只用 `api.github.com`（base64 取 contents）与 `openrouter /models` 元数据，禁直连 github.com/huggingface.co；**候选只读元数据、绝不发推理请求**，接入必须主人批准（MR §4.6）。
8. **流式**：分界点=首字节。首字节前失败可换端点（journal 无感）；首字节后断流**绝不自动重放**，抛 `StreamInterruptedError{consumedTokens,…}` 交 journal 裁决（对齐"绝不重复执行"）（MR §4.7）。
9. **attemptId 契约**：主循环 LLM 步 `attemptId = journal callId`（契约 J1：`beginLlm` 返回 `{seq,callId}` 补上了 MR 的悬空要求）；非 journal 即时调用 `attemptId='nonj:'+ULID`；`attemptSeq` 由路由在单次 route() 内自增、经 RouteMeta 回传，调用方不传。
10. **体积回收**：janitor 每日清 sample 环形 20 条、log 30 天/20 万行截老、breaker_event 90 天、候选 TTL（7d 无人理→expired、拒后 30d 冷却、批准断链启动对账补齐）；总量估 <50MB（MR §3.2/§4.7）。

**关键接口**：`complete(req)/stream(req)/trackForEvent/snapshot()/manualProbe/resetBreaker/reloadConfig`；`emergencyActive` 位；`onApprovalResult('recon_candidate',id,approved)`；错误契约五类（`AllEndpointsDownError/NoQualifiedPrimaryError/StreamInterruptedError/DeadlineBudgetError/AuthConfigError`）；`outboxUnresolvedSignatures()`（契约 T3 为 MEM 轮转守门新增，不开 SELECT 例外）。

**已裁定差异**：MR 原文的 `waiting_model`、`completeMain/completeLow` 名、`notifySOS`、`governance:emergency` 发布、`alerts.outbox_path=/dot/state/OUTBOX.md` 均按契约作废/改述（T1/T3/T4）；治理订阅 `router.mode_changed` 自读 emergencyActive。

---

## 4. 模块三：治理与审批（Governance）

> 原文：`modules/governance.md`（rev2，15 条评审响应）。进程内库，主循环每步同步调 `evaluate()`；拥有审批 8 态状态机、五档工具分级、前后审查、quarantine、审计、spend 台账。

**核心决策**

1. **五档分级**（read/write_file/browser/spend/dangerous），默认策略：read/write_file→allow；browser→review（低智能前审放行，判危转人工）；spend→approve 一律人工；dangerous→approve+Web 勾选确认。`upgrade.whenContains` 子串命中提档；`rules.yml` 只能收紧不能放宽；**未登记工具一律 deny**（白名单制，GOV §2）。
2. **登录态判定谓词（最重要的统一术语之一）**：契约 G1 裁定以执行面为准——`isLoginSensitive = tool.startsWith('browser.') && call.identity != null && call.identity !== 'anon'`，identity 缺失 fail-closed 按登录态。**GOV 磁盘稿的 `params.withIdentity/identityParam` 谓词作废**：判定建在模型自填 args 上是 fail-open，顶层 `identity` 由 Runner 注入不可伪造（GOV §2.4 待按契约改写）。
3. **审批 8 态状态机**（全文 §9.3）：pending→approved/rejected/expired；approved→executing(执行面 CAS claim)/revoked；executing→executed/failed。**裁决即终局**：rejected/expired 不可翻案不可复活（契约 G2 关闭 GOV O1/surfaces 复活诉求；迟到回复 = late_decision 审计 + `{ok:false}` 记账）；executing 后不可 revoke（安全边界在认领前）。TTL 定稿 24h（契约 G2 裁 GOV 默认值；"重做 = 重新产生新审批单"）。
4. **先到先得单点写**：所有通道（Web 卡片/TG/CLI）都进 `decide()`，SQLite 条件 UPDATE `WHERE status='pending'` 单写者串行即"先到先得"；**审批唯一事实源 = GOV `approvals` 表**，surfaces/CP 的自建审批表全部降级/删除（契约 J6/S-2）。TG 寻址 `AP-#<seq>`（seq 由 `gov_seq` 同事务 UPDATE+RETURNING 生成，跨清理单调）；`approve_remember` 在 TG 禁用（防手机误触形成持久授权）。
5. **非工具审批单**：`kind ∈ {tool_call, synthetic, question}` 复用同一状态机双通道——synthetic 承接侦察候选（`subject_key='recon:…'` 幂等）、副作用未知（`'unk:'+callId`）；question 供 Agent 向主人提问（verdict=approve_once+note）。**emergency_override 类已删**：降格授权唯一路径=改 models.yml（配置即授权，MR 评审响应第 10 条）。
6. **主人补充指令通道**：`decide(…,note)` ≤500 字符，经 `onApprovalSettled(taskId,apId,ok,{note})` 回传，Runner 注入恢复步上下文（"批准，但只跑 dry-run"）；治理不解析语义，附条件强制执行属阶段三。
7. **执行前后审查**：precheck 走低智能轨，容量按 7 tok/s 实测逐 token 核算（输入截断 goalDigest≤800B/params≤1.5KB、行协议输出 max_tokens=40、总预算 45s）；**审查器自身有熔断**：10min 内 5 次超时→degraded 15min——降级只给可逆档 fail-open（write_file allow+`reviewSkipped` 落库可回放），browser fail-closed 转人工；同任务 5min 内第 2 张起批量卡片合并防洪水（GOV §5.1）。post-review sanitize 脱敏后三分类 ok/suspicious/quarantine，**永不 fail-open 为 ok**；判 quarantine ⇒ **先 INSERT `quarantines` 表成功才发事件**，控制面每次出队前同步 `isQuarantined(dotId)`，重启不丢；解除 `liftQuarantine` → CP `resumeDotQueue`（契约 G3 补齐 per-dot 队列暂停 API）（GOV §5.4）。
8. **记忆化授权（阶段二接口一并在结构内）**：`approve_remember` 派生 `endpoint_grants`（origin 级）/`approval_rules`（谓词级），Web 卡片先展规则预览确认才落库；每 dot 每档 50 条 LRU 自动过期、默认 90 天失效；**spend/dangerous/登录态/侦察候选永不入记忆**；emergency 期间 browser 档记忆休眠；人工收紧 rules.yml 永远压过记忆（GOV §4）。
9. **spend 台账**：evaluate 先校验参数契约（amountCents/currency/category，不清账直接 deny）；resolveExecution 写 charge/void；无自动对账，人工 `recordSpendAdjustment` 补录（GOV §2.5）。
10. **审计**：只追加 `audit_log`（21 种 action 枚举，含 late_decision/reentry_after_terminal/illegal_transition 三类"bug 信号"）；90 天/2 万行在线窗口，compactAudit 按 id 区间导出 jsonl.gz+sha256 归档 ≤200MB（GOV §6）。

**钩子联动（契约 J6 定稿签名）**：`evaluate→approve` 后**由 Runner（非治理）**调 `setAwaitingApproval(taskId,epoch,approvalId)`（治理不持有 epoch）；治理在 decide/expire/revoke 三条异步路径的事务提交后调用栈内触发 `onApprovalSettled(taskId,apId,ok,meta)`；deny/ok=false 时控制面 `journal.skipStep(callId,reason)`。控制面对治理：`forceApproval(taskId,{kind,subject:{journalStep:callId,…},reason})`。

**已裁定差异**：GOV 磁盘稿的 `control.db`（D1）、`lowIntelligence.complete()/requestHelp()`（G4：统一 `complete({track:'light',deadlineMs:45000,…})`、求救复用 MR alert_dispatch）、`governance:emergency` 事件（T1：改订阅 router.mode_changed）、`setAwaitingApproval` 缺 epoch（J6）均按契约改。

---

## 5. 模块四：执行面容器（Execution）

> 原文：`modules/execution.md`（rev2，11 条评审响应 + 实测记录：WSL dockerd 29.1.3 = API 1.52/min 1.44）。职责：每 Dot 一容器的编排、宿主↔容器工具协议、幂等 ledger、浏览器/身份 profile/文件 shell 工具、资源与磁盘治理。不决定"该不该执行"。

**核心决策**

1. **拓扑**：daemon 与 dockerd 同在 WSL，经 `/var/run/docker.sock` unix 直连（dockerode，无 TCP 2375、无 docker CLI 子进程）；daemon→容器走 bridge 网 HTTP :9223 + Bearer token；Windows 侧永远碰不到 docker.sock。**容器→宿主方向由 `HostNetGuard` iptables 链 `DOTD-OUT` 落地**（enable_icc=false 只管容器互访）：默认全拒宿主侧端口、白名单由治理 `setEgressWhitelist(ports)` 下发（阶段一默认空=只出外网；契约 T5 定阶段二白名单 = 宿主模型 base_url 端口 + 7788）、网关 IP 从 `GET /networks/{id}` 动态读、boot 与 docker 恢复时幂等重装（EX §2.1）。
2. **幂等 ledger（协议核心）**：容器 agent-runtime 在 **state 卷** append-only JSONL 按 `call_id` 记账——同 call_id 至多执行一次工具体；`done` 项**跨 recreate 保留并可经 `GET /calls/{call_id}` 重放 result**（"绝不重复执行"在 recreate 场景闭环）；进程重启只把 `doing` 标 `aborted`；ledger 压缩只动"已被控制面确认"的 done 项（compacted 重放=确认幂等成功但结果降级）；**exec 永不自动重试**，未完成调用一律只回报 `exec.call.interrupted(callId)`，重派换**新 call_id** 是 journal 的决定（契约 J1-1）（EX §5.4）。
3. **容器生命周期状态机**（16 态，全文 containers.state CHECK）：absent→image_ready→created→booting→ready⇄busy/idle→suspended(`docker pause` 默认节能档)→(可选 deep stop)→removed；unhealthy 一次自动 recreate，>3 次/24h 或 recreate 仍败→`quarantined` 人工解+求救事件。daemon 启动 **reconcile**：以 `docker ps -a` label 过滤对账 SQLite，幂等 boot 序列 ping→ensureImage→HostNetGuard→reconcile→create/boot；booting→ready 后逐 open call 查 `/calls/` 取回 done、续轮询 doing、aborted/404 报 interrupted（EX §4.1/§13.1）。
4. **单镜像全局唯一**：Playwright 官方基座 + xvfb + agent-runtime，身份差异全在卷里（盘小约束的决定性设计）；`ReadonlyRootfs`+tmpfs+named volumes → 可写层近零（EX §3/§4.2）。
5. **资源护栏**：默认 mem 1536MB 禁 swap / cpu 2000m（唯一事实源 `exec_dots.limits_json`，CP 只经 API 消费，契约 J5）；全局闸门 maxActiveContainers=2、容器内存总预算 4096MB、放行前读 MemAvailable<4GB 拒+驱逐最老 idle；`OomScoreAdj=700`——内存压力时 dotd 容器先被 OOM，保护 netfuzz（EX §4.2/§4.3）。CP 的水位指令映射：pause/unpause→`pauseContainer/unpauseContainer`（幂等）、kill→`destroyDotContainer(keepVolumes)`、stats→`getContainerStats{memMb,hasInflightCall}`（判据 `exec_calls.state IN ('sent','running')`）（契约 J5）。
6. **浏览器管理**：Xvfb 由 runtime spawn；`BrowserHolder` 进程级复用 chromium，**每身份一个 `launchPersistentContext('/dot/profiles/<sha16>')`**——登录态天然持久在 profile 卷；三层内存防线（容器 cgroup / 高水位 80% hardReset / context 老化回收）；崩溃=当次调用 `browser_crashed(retryable)` + 下次自动重开（EX §6）。

   **阶段一身份链路（登记 · 首登 · 验收前提）**——本节补本次读者意见 F1 的缺口，登记侧全部有原文依据，首登通道是真实设计空洞、如实列为待拍板项：
   - **登记**（原文可补）：引导期由 daemon 进程内调 `ExecService.setIdentityProfile('dot1', identityKey) → {profileHash}`（EX §10:542），写 `exec_identities` 行（EX §9:457-465，`profile_hash=sha256(identity_key)[0:16]` 即 profile 目录名）；`identity_key` 是语义名（如 `'x_main'`），Runner 注入到 `ToolCall.identity` 顶层字段（契约 G1），治理谓词与审计落名都以它为准（EX S5:564）。首次 `browser.*` 调用时 BrowserHolder 在 profiles 卷内懒建 `/dot/profiles/<hash>/` 目录（EX §6.1:323），无需预建。MVP 交付物 = 该接口接线 + 至少一个身份行；对主人暴露为 CLI/HTTP 属 SF 路由表机械扩展，非新设计。
   - **首登**（真实空洞，需主人拍板 → §11.2 B16）：六份模块文档与契约均未设计"主人如何在 headed+Xvfb 容器里完成第一次人工登录"——容器内无显示转发通道，SF 路由表无身份/登录页。候选通道（**本文建议、非原文设计**，按侵入性排序）：(a) **profile 卷预置**：主人在宿主已登录的 Chrome profile 复制进 `dot1-profiles` 卷对应 `<hash>/` 目录（纯运维操作，零新接口，cookies/storage 随卷持久，与 EX §6.1:323 懒建目录天然兼容）；(b) **WSLg/X11 转发**：宿主 Win10 19045+WSL 内核是否可显示容器内 `Xvfb :99` 的 chromium 窗口，属施工期实测项（§11.2 C10）；(c) 审批卡片辅助的 agent 登录流——需 GOV/EX 新设计且凭据会经 journal，MVP 不推荐。
   - **验收前提**：锚① 与 D8/D13 的"登录态用例"以 (a) 或 (b) 任一通道完成过一次真实登录、profile 目录内有有效 cookies 为前提；两通道都不可用时，锚① 退化为 `identity:'anon'`（ephemeral context，契约 G1）的非登录态浏览器任务，登录态恒 approve 用 `forceApproval` 合成单测替代并在验收记录注明。
7. **工具面与安全**：sync/async 由能力目录 `mode` 声明（sync 强制 deadline≤60s）；fs.* 限 `/dot/home` + symlink 双查 + 4/8MB 物理限；shell.run 以 **uid 1001** 跑（runtime=1000），token ro-bind 0400、ledger 独立 state 卷 0700——**秘密靠跨 uid 权限挡住 shell**，`.dotd/` 目录名隐藏降为纵深防御；`CapAdd:[SETUID,SETGID]` 其余全 drop、no-new-privileges（EX §7.1；依赖实测 → 开放问题 Q7，见 §11.2）。
8. **Capability 目录**（契约 J2 增字段）：`{name, mode, max_deadline_ms, args_schema, sideEffect:'safe'|'replayable'|'unknown'}`——sideEffect 是 journal 崩溃恢复分流唯一依据；词表 ⊆ tools.yml 登记名校验，增删工具 bump `runtime_ver`。
9. **磁盘治理**：home/profile 卷各 2GB（超限只告警不删——记忆数据主权归主人）、state 卷 64MB、profile 缓存 80% 水位自动清、DiskGardener 每 6h prune dangling/无主卷（白名单=`exec_volumes` 表防误删）、free<5GB 触发（EX §8）。

**已裁定差异**：EX 磁盘稿 §5.2 端点表须新增 `POST /fs/ops {op:'read'|'list'|'stat'|'rename'}`（契约 S4'：MEM 的注入读取/原子写/索引对账全依赖它，阶段一交付）；§6.1 补 `identity:'anon'|null → ephemeral context 不入台账` 分支（G1）；env 模型 base_url 注入收紧（容器内工具不得直连模型，MR 铁律）。

---

## 6. 模块五：记忆系统（Memory）

> 原文：`modules/memory.md`（rev2，15 条评审响应）。两层：文件记忆（/dot/home 笔记与手册）+ SQLite 会话历史；起步不上向量库，升级判据埋点自带。

**核心决策**

1. **thread ≡ session 同 id**（契约 M1）：`tasks.session_id` 与 `tasks.thread_id` 都指 `mem_threads.id`；对话任务 SF 先 `openThread` 带 threadId 提交，事件/心跳任务 Runner 首步 `openThread('event')` 后经 **`cp.bindSession(taskId,epoch,…)`** 回写（契约 M2 否定了 MEM 原稿"Runner 直接 UPDATE tasks"——绕 epoch 围栏）。恢复唯一入口 `buildSessionReplay(threadId,taskId,budget)`：**assistant 全文在这里**（journal 只存 digest），恢复顺序固定"先问 journal 要不要重放、再问 messages 聊到哪"（契约 J3/M1）。
2. **文件记忆规范**（`/dot/home`）：`MEMORY.md`（索引+当前关切，4KB 硬限、固定段落名保证解析简单）、`notes/YYYY-MM-DD-slug.md`（情景记忆、头部 date/task/tags）、`manuals/<domain>/*.md`（写给未来的自己：When to use/Steps/Pitfalls/last_used）、`.archive/`（**保持 .md 原文件整移入，不打包**——守住"可 grep"）、`.tmp/`（原子写）、`.dotd/`（exec 保留区不索引；注：秘密已迁 state 卷，此约定为纵深防御，契约 M4）。
3. **读写时机状态机**：READ-INJECT（MEMORY.md 必注入≤2500tok + manuals 朴素匹配 top-2 + 会话近 8 条≤4000tok；**notes 不预取**，给 Pointers 让 Dot 用 `shell.run grep` 自取——盘小+预算紧的刻意设计）→ 执行中随时 fs.*/shell → **WRITE-SEAL：三种终态（done/failed/cancelled）全走**（契约 M3 裁定 CP 接受：finish 成功/失败、看门狗、背压 kill、queue_evict、优雅关停都必须调 `sealTask`）；done 且本轮没写记忆文件→注入一轮"写笔记或回复 SKIP"提醒（软线，防垃圾记忆）；failed/cancelled 只记 `memory_missed`。
4. **工具词表**（契约 M5）：模型面**只有** `fs.read/fs.write/fs.list/fs.stat/shell.run` 五个注册名（memory_* 四工具作废）；检索=shell.run grep；记忆限额是**策略层**（MEMORY.md 4KB、note 16KB、notes 120 文件、home 2MB 只读期…），执行面 4MB/8MB/2GB 是物理兜底，**更严者生效**；软限 warning 由 Runner 前置 `beforeWrite` 附回工具响应（契约 M6）。原子写 = `.tmp/<uuid>` → `/fs/ops rename`。
5. **daemon 侧不碰卷**（铁律 A/B）：注入读取、索引对账、.tmp 清理全经执行面 `/fs/ops` HTTP 桥（Bearer），daemon 不 walk 卷目录；容器未在跑→注入降级只缺文件部分并记 `memory_missed`，不阻塞任务。
6. **整理与摘要**：心跳 job `memory-compaction`（每小时探测，>60 未归档/超 1MB/14 天兜底触发）与 `memory-retention`（每日）经 `registerInternalJob` 挂载、只做探测与投递，重活经 `submit({payloadJson:<CompactionJobSpec>})` 入队（契约 J4/M7/E2——MEM 原文简写"submit(track='light')"的定稿口径：track 不是 submit 参数、tasks 无 track 列，light 打标由 `memory.*` 前缀与 CompactionJobSpec 载荷完成，载体推导见 §2"track 的定界"与 §11.2 D5 条）；整理动作走 `/fs/ops` 维护模式**不用 shell.run**（避免 sideEffect 审批歧义）；不可逆保护：只移入 .archive 不删除，真删仅主人 `dotd notes purge`。摘要失败（本地模型不可用）→跳过，注入退化为近 8 条+旧 summary——**记忆问题永不炸主循环**（错误只抛容量红线与库损坏两类）。
7. **保留与封存**：sealed 判据锚 `last_task_finished_at`（任务真终态而非"聊完"；awaiting_approval 未走完 sealTask 天然豁免）；90d+30d→sealed、sealed+365d→CASCADE 删（删前摘要指纹进 purge_ledger）；事件/心跳 thread 7 天自动封存；`dotd history keep` pin 永不删。db 软限 200MB/硬限 500MB。
8. **崩溃恢复**：启动 `PRAGMA integrity_check` 失败→不经 SQLite 直接 append `~/.dotd/OUTBOX.md` HELP 块（签名 db_corrupt）+ **拒启动**（与迁移失败同级，无"半开只读"状态）；会话断点扫描只对 status='running' 报待恢复，终态缺 task_end 判 sealTask 漏调、retention 补写 `backfilled:true` 不淹恢复链。
9. **升级向量库判据**（§6.4）：空结果率>40% 持续两周、"上下文明明有但答不出"反馈 ≥2 条/周、全量 rg>2s、Dot≥3 跨 Dot 共享——任一触发；选路 sqlite-vec 同库加列，不引入独立向量服务。FTS5 一行 DDL 预留。
10. **OUTBOX 守门**：格式/写者归 MR，MEM 只做超 64KB/200 块的**按块轮转**，未收敛 HELP 块（经 `outboxUnresolvedSignatures()`，契约 T3）永不轮转。

---

## 7. 模块六：交互面与事件入口（Surfaces）

> 原文：`modules/surfaces.md`（rev2，13 条评审响应）。人机面（Web UI/CLI/TG 阶段二）+ 机器入口（HTTP webhook/JSONL 监听/心跳投递）。**rev2 总原则：表与状态机属主归其定义模块，本模块只做适配层**——不自带审批表、不自建状态机、不写 OUTBOX。

**核心决策**

1. **三分投递铁律**（契约 S-1）：一条入站激励恰好命中一条路径——webhook/JSONL/心跳/TG 聊天→`cp.ingestEvent`；Web/CLI 主动聊天与手动任务→`cp.submit`（对话消息先 `memory.openThread` 带 threadId，priority=1）；**审批回复→`gov.decide()/resolveTelegram()`，绝不进事件流**。
2. **唯一 HTTP 监听 `127.0.0.1:7788`**（契约 H2）：鉴权（master_token/readonly_tokens/Origin 白名单防 DNS rebinding）、CORS、SSE、CLI base 全单点；CP 的 REST 子集（GET /tasks、/journal/:taskId、/guard）由 SF 路由器进程内转调 CP 函数、不开第二端口；hooks HMAC（timestamp±300s + nonce LRU + body≤256KB）。Windows 经 netsh portproxy 访问。
3. **入口只做 normalize+dedup+限流后投递**：落库/匹配/建任务全在 CP；`ingestEvent` 同步部分 <10ms、LLM 匹配异步两段式，UI 容忍"先 pending 后 matched"。优先级映射表归 SF：interactive=1 / heartbeat·hook=5 / bulk=7。CP 因 maxQueued 拒绝→映射 503 retryAfterMs 供 hook 方重投。
4. **dedup_key 规则唯一权威在 SF §4**：`hb:<ct_id>:<next_fire_ms>` / `file:<path>:<ino>:<gen>:<行>` / `<source>:<extId|sha256(body)[0:16]>` / `tg:<update_id>`；JSONL 旋转/截断 `gen++` 防行键撞旧；offset 只在完整行+投递成功后前进。
5. **心跳 tick 语义**（实现交付为 CP `registerInternalJob` 的 `heartbeat.tick`，契约 H1/J4——SF 原 `registerIntervalJob` 作废）：**先推进 next_fire 后投递**（崩溃窗口宁可漏一次，绝不补发风暴）；quiet_hours / skip_if_busy（数据源 `cp.list({status:['queued','running'],dotId}).length`）/ catchup='latest' 补投一次；`surf_heartbeat_state` 独立表删除，扩展列并入 `crontabs` 单表。
6. **SSE 总线**：游标=独立 `bus_seq` 计数器（`surf_sse_cursor` 持久化重启续读；不借任何业务表 id）；超 5000 条重放窗→`resync`+REST 快照校正；`chat.delta` 不落库、订阅者队列满则丢、靠 `chat.final` 校正。上游事件名直接订阅转发：GOV `approval:*`、MR `router.mode_changed`、CP `onBus(task.state/guard.level/…)`。
7. **Web UI**：Vite+React18 纯 CSS；审批卡片按钮=GOV 三值 verdict + dangerous/spend 勾选确认，`approve_remember` 仅 Web（弹规则预览）；状态徽章/枚举全用 GOV 导出词汇表，页面不自行判定状态合法性；tier 五档徽章。
8. **Telegram（阶段二，接口结构阶段一即定型）**：出站长轮询 getUpdates（NAT 友好零托管）；**先持久化 offset 后处理**，at-least-once 重复由 CP `events.dedup_key UNIQUE` 吸收；入站先粗筛审批指令交 `resolveTelegram()`，非指令聊天 ingest 为事件（3s debounce 合并仅非指令）；渲染用 GOV `renderTgNotice`，卡片 edit 节流 + `surf_tg_card_state.reminded_at` 先查后写防重复提醒。
9. **CLI**：`dotd serve/status/ask/approvals/approve/deny/watch/events/logs/task/cancel/hook/hb/sos-test`，全经 7788 HTTP、不可达退码 7、绝不直写 SQLite。
10. **NotificationChannels 适配器**（供 MR 注入）：`deliver(channel,text)/available(channel)`；本模块**永不写 OUTBOX、不做 24h 去重**（防双账本）；email 适配器阶段二由本模块认领实现（补"两模块都没认领"的空洞），阶段一 `available('email')=false` 全走 OUTBOX。
11. **自有表仅 4 张**：`surf_jsonl_offset / surf_tg_card_state / surf_ingress_rejects / surf_sse_cursor`；`surf_ingress_rejects` 记"从未抵达 CP 的拒绝"，与 CP 侧 dup 事件审计两套不混写（契约 E1）。
12. **分期**：阶段一 = HTTP 入口+心跳+Web UI+CLI 全量，JSONL 定型默认关；阶段二 = Telegram 全量+email；TG 审批双通道是阶段二项，阶段一审批走 Web/CLI（CTX:51 口径内）。

---

## 8. 端到端数据流走查：一条 HTTP 事件的一生

> 本章即契约 §8 全链路定稿的叙事化，配"崩溃在每个环节的后果"。场景：Grafana webhook 报出一条 CVE 情报，任务要求"查 GitHub 上对应 advisory 并用登录态浏览器在 X 站发一条提醒帖"——后半段必然触发审批。

### 8.1 正常流（12 段）

**① 入口（SF）**：`POST /hooks/grafana`。HMAC 验签、Origin、限流、zod 规范化 → `dedup_key='grafana:<payload.id|sha256(body)[0:16]>'`、priority=5。被拒的消息落 `surf_ingress_rejects`，不进事件流。

**② 投递（SF→CP）**：`cp.ingestEvent({source:'http',dotId:'dot1',payload,dedupKey,priority})`——同步单事务 `INSERT events`；撞 `dedup_key UNIQUE` 幂等返回 `{eventId:旧id, dup:true}` 不重入管线。成功后 `setImmediate(scheduler.wake)` 不等 1s tick。**HTTP 响应 202 {eventId} 在事件落库即返回**，匹配是异步的。

**③ 匹配（CP）**：规则层（`event-rules.yml`：source/关键字→run_new）零成本命中，via=rule confidence=1.0；若规则未中→LLM 层 `complete({track:'light',deadlineMs:15000,attemptId:'nonj:'+ULID})`（本地 Colibrì 优先），严格 JSON 一次解析。产出 `BEGIN IMMEDIATE { INSERT tasks(id='tk_ev_'+eventId, payload_json, thread_id=NULL) + INSERT event_decisions + UPDATE events.status='matched' }`。置信 <0.55 → status='inbox' 等主人一键 retryMatch。

**④ 领取（CP pop）**：单写者事务，谓词全式见 §2 决策 3 定稿：背压∈{normal,guarded} ∧ `runningCount(dot)<maxRunningTasks(=1)` ∧ `WHERE status='queued' AND (run_at IS NULL OR run_at<=now)` ∧ ORDER BY `priority ASC, COALESCE(run_at,created_at) ASC, resume_from_seq IS NOT NULL DESC` ∧ `run_epoch+=1` → 任务入 running，Task 快照带新 epoch 交 Runner 协程。

**⑤ 上下文装配（Runner）**：`memory.openThread('dot1','event',{originTaskId})` → `cp.bindSession(taskId,epoch,{sessionId:threadId,threadId})` → `memory.buildContextBundle`（经容器 `/fs/ops` 读 MEMORY.md + manuals 命中片段；容器未跑则本次跳过记 `memory_missed`）→ `mem_messages` 写 `task_start`。

**⑥ LLM 步（journal→MR）**：`journal.beginLlm(taskId,epoch,promptDigest)` 返回 `{seq, callId}` → `modelRouter.complete({track:'primary', attemptId:callId, tools:[…], messages:ctx})` → `endLlm(seq, respDigest)`。路由内 NORMAL 档命中 OpenRouter；失败换端点不换 journal 步骤（一次 route=一个步）。模型输出的下一个动作是 `browser.snapshot`（读页面，tier=read 直放）若干轮，然后是 `browser.act`——`ToolCall{call_id, tool:'browser.act', args, identity:'x_main'}`（identity 由 Runner 注入，模型无法伪造；该身份行的登记与首登见 §5"阶段一身份链路"——本走查以其完成过首登为前提）。

**⑦ 工具步闸门（journal→GOV→EX）**：
`journal.beginTool(...)→{seq,callId}`，status='started' 即 **call_sent**（synchronous=FULL，行提交先于任何外部调用）；
`governance.evaluate(ctx{epoch 经 taskRef}, call{callId, tool, params, identity})`：
- tier=browser 默认 review 档 → precheck 走低智能轨（45s 预算）判 risky；
- 且 `isLoginSensitive`（browser.* ∧ identity≠null/anon）为真 → **alwaysApprove**，不可被任何记忆/规则豁免；
→ 返回 `{kind:'approve', approvalId}`：
`journal.markPending(seq, approvalId)`（步转 'pending'——**等待态，不是崩溃孤儿**）+ `cp.setAwaitingApproval(taskId, epoch, approvalId)` → 任务 `awaiting_approval`，**Runner 让位、不占 runningCount**。

**⑧ 审批触达（GOV→SF）**：`insertApproval`（gov_seq 同事务取号 → `AP-#42`，TTL 24h）→ 广播 `approval:created` → SF 渲染 Web 卡片 + SSE 推送（阶段二另有 TG `renderTgNotice`）。卡片数据全来自 `ApprovalView`（GOV §3.5）。

**⑨ 裁决（主人→GOV→CP）**：主人在 Web 点"批准一次"附 note"发之前先给我看草稿"：HTTP `POST /api/approvals/42/decision` → **唯一写路径** `gov.decide(42,'web',approve_once,'主人',note)` → 条件 UPDATE `WHERE status='pending'` 先到先得；若 TG 通道（阶段二）已抢先用掉，则 `{ok:false, reason:'已被…抢先裁决'}` + `late_decision` 审计，绝不二次执行。提交事务后调用栈内 `cp.onApprovalSettled(taskId,42,ok,{note})`。

**⑩ 恢复执行（CP→EX→容器）**：ok → 任务回 `queued`（resume_from_seq=该步，priority=min(·,2)）→ pop 拿**新 epoch** → Runner 经 `buildSessionReplay` 重建上下文（assistant 全文来自 MEM、工具结果全文以 callId 从 steps 回填、note 注入）→ 把该步 `pending→started`，**复用原 call_id**（从未派发过 exec、ledger 无记录、无幂等冲突，契约 J1-2），以治理固化的 `final_params_json` + note 执行 → `exec.runTool(ToolCall{call_id=callId,…})`：ExecService 查能力目录 mode='async' → `POST /jobs/start`（Bearer token, idempotency-key=callId）→ 容器 ledger `doing→done` → ExecService 轮询 `/jobs/{id}` 到终态 → `journal.endTool(succeeded, result)`=**call_done**，此后才可派下一步。

**⑪ 回报与收口**：assistant 回复全文 `appendMessage(kind='text')` 入 thread（tool 消息只存 digest+200 字预览——双写禁令）；任务 `ctx.done` → `memory.sealTask(task,'done')`（task_end 系统消息 + 若本轮没写记忆文件注入一轮"写 notes/manuals 或回复 SKIP"提醒 + `last_task_finished_at` 锚）→ `cp.finish(taskId,epoch,{ok,summary})`（epoch 围栏校验）→ `task_results` 落库、状态 done → SF SSE 推送主人："CVE 情报已处理，帖已发"。

**⑫ 收尾治理**：post-review（tier≥browser 触发）sanitize 后低智能三分类；判 quarantine → 先 INSERT `quarantines` 再发 `governance:quarantine` 事件 → CP `pauseDotQueue('dot1')`，出队前同步查询挡住复跑；MR 订阅该事件走 alert_dispatch 通路求救（契约 G4）。

### 8.2 崩溃在每个环节的后果

| 崩溃在 | 库状态 | 恢复动作 | 后果与保证 |
|---|---|---|---|
| ①② webhook 处理中（HTTP 已收、events 未落） | 无 event 行 | 调用方重投；JSONL 源按 `surf_jsonl_offset`（只停完整行）自重；TG 按"offset 先持久化"重拉同批，`tg:<update_id>` 撞 UNIQUE 吸收 | 入口各有断点账本；**可能重复 HTTP 请求，绝不重复事件行** |
| ② events 已落、未决策 | 无 event_decisions 行 | 启动步骤 6 `replayUndecidedEvents()` 重跑幂等事务 | PK=event_id 天然幂等，不重决策 |
| ③ 建任务事务中（BEGIN IMMEDIATE 未提交） | 事务回滚，无半行 | 同上重跑 | `tk_ev_<id>` 确定性主键撞 PK 即回滚——**绝不双建任务** |
| ④ pop 后、Runner 首个 journal 写前 | running、无 started 步 | 看门狗/重启 resolveOpenStep 无可处理行 → 任务回 queued attempt+1 | 无副作用，最多浪费一次 epoch |
| ⑤ bindSession 前崩溃 | thread_id=NULL | 重领时 Runner 重走 `openThread(event)+bindSession`（origin_task_id 判重） | 会话不丢不双建 |
| ⑥ beginLlm 后、LLM 响应前 | llm started 孤儿 | `markInterrupted`，**不重放 LLM**（省钱）；恢复从自然下一步续，全文重建走 `buildSessionReplay`（assistant 全文归 MEM） | 只损失一次 token 花费，无副作用 |
| ⑦ beginTool 后、runTool 未发出（或发出未达） | tool started 孤儿、exec_calls 无行或 'sent' 无回执 | 按 sideEffect 分流：safe/replayable 重放（**新 call_id**）；unknown 先 `exec.reconcileCall`→404/aborted 标 interrupted 重放、仍未知 → `forceApproval(kind='side_effect_unknown', subject_key='unk:'+callId)` 转人工 | **"绝不重复执行"的最后一道闸**：宁可停下来问人 |
| ⑦⑩ runTool 已发出、工具体在容器内执行中 | started 孤儿 + 容器 ledger doing | booting→ready 后 reconcile：ledger 仍是 doing→续轮询原 job；进程真死→标 aborted 报 `exec.call.interrupted` → journal 分流同上 | 容器 ledger 在 state 卷跨 recreate 存活 |
| ⑩ 工具体已完成、endTool 未落库 | started 孤儿 + ledger done | `reconcileCall='done'` → `GET /calls/{callId}` **取回 result 补记 succeeded，不重放** | 发帖发出去了但系统知道"已发"——不重复发帖（本场景最关键的一格） |
| ⑨ 裁决事务后、钩子前（或 awaiting 期间 daemon 重启） | approvals=approved、任务 awaiting_approval、步 pending | 启动 recoverAwaiting 纯读库：查治理 approvals 当前态走审批续跑路径；步 pending 不是孤儿不误标 interrupted；恢复执行复用原 call_id | 审批状态随库持久，**重启不丢审批**；主循环让位无悬空推进（钩子在调用栈内+恢复读库双保险） |
| ⑫ sealTask 中 / finish 事务中 | running 无 task_results / thread 缺 task_end | 任务回 queued 重跑（多数步从 succeeded 短路）；retention 补写 `task_end{backfilled:true}` + violation 日志，不涌入恢复链 | 会话历史不出现永久断点噪声 |
| 模型层穿插：complete 全候选耗尽 | `AllEndpointsDownError` | CP `pauseByReason(taskId,'circuit_open')`（**无 waiting_model 态**）；MR 账本先行发求救（阶段一落 `~/.dotd/OUTBOX.md`）；mode 变好广播 → CP 订阅 `router.mode_changed` 批量回 queued + 恢复通报 | 任务挂起不烧额度、自动续跑；求救 24h 去重、崩溃由 pending 对账保证"绝不漏发"（最坏一次重复带 #N 标注，有意取舍） |

非法写入的统一防线：**epoch 围栏**——被回收/kill 的旧 Runner 协程任何迟到 `heartbeat/endTool/finish` UPDATE 带旧 epoch，行数 0 → 拒绝 + `resource_events(kind='stale_writer')`；治理侧终态单重放禁令（`reentry_after_terminal` 审计）挡住控制面误重放终态步。

---

## 9. 阶段一 MVP 实施清单

范围（CT:51）：daemon+SQLite 队列+journal、OpenRouter 主循环、Playwright 容器、文件记忆、CLI/Web 审批、心跳与 HTTP 事件入口、降级到本地模型。**"降级到本地模型"在阶段一的定稿含义**（本次读者意见 F2，判定口径见 §11.3 锚③）：mode 链能自动降到 LOCAL_FALLBACK 且 **light 轨真实由 tier2 承接**（models.yml tier2 默认行，MR:71）、primary 轨按 §4.3 默认挂起为 `paused(circuit_open)`、恢复自动续跑——不含"7B 跑主循环"（那是 B1 批准后的变体）。**不含**：Telegram、email、免费池实接入、多 Dot、反检测增强（阶段二/三项：MR 阶段一=两级 Tier1→Tier2 降级+熔断持久化+OUTBOX 求救；免费池/侦察/求救闭环代码结构在位但池空、channels=null）。

### 9.1 仓库目录树

```
dotd/
├─ package.json  tsconfig.json  .gitignore
├─ db/migrations/                 # CP db 层为唯一 runner，PRAGMA user_version 递增（契约 D3）
│   ├─ 000_control_plane.sql      #   events·crontabs·tasks(+payload_json,source_event_id)·steps
│   │                             #   ·task_results·event_decisions·resource_events
│   ├─ 010_model_router.sql      #   MR §3.2 八张
│   ├─ 020_governance.sql        #   GOV schema.sql 九张
│   ├─ 030_execution.sql         #   EX §9 七张
│   ├─ 040_memory.sql            #   MEM §5.3 四张
│   └─ 050_surfaces.sql          #   SF §4 四张（surf_tg_card_state 无 REFERENCES，契约 D2）
├─ config/
│   ├─ dotd.yml                   # 全局：数据目录、dotdReserveMb、maxQueued、.wslconfig 注记
│   ├─ models.yml                 # MR §2.1（alerts.outbox_path: ~/.dotd/OUTBOX.md，契约 T3）
│   ├─ free-models.yml            # 阶段一收录为空/占位，结构定型
│   ├─ tools.yml                  # GOV §2.2（fs.read/fs.write/fs.list/fs.stat/shell.run/
│   │                             #   browser.open/act/snapshot/close/net.get/net.post；无 identityParam）
│   ├─ rules.yml                  # 人工收紧规则
│   └─ event-rules.yml            # CP 匹配规则层
├─ src/
│   ├─ daemon.ts                  # dotd serve：装配层（openDb→migrate→模块 init 顺序：CP→MR→GOV→
│   │                             #   EX→MEM→SF，注入 GovDeps/NotificationChannels/TaskImpact 全在此）
│   ├─ shared/                    # bus.ts(EventBus) · ulid.ts · ids.ts · errors.ts
│   ├─ db/                        # conn.ts(单连接 PRAGMA) · migrate.ts(user_version runner)
│   ├─ control-plane/             # types.ts queue.ts journal.ts scheduler.ts(registerInternalJob+popLoop+
│   │                             #   看门狗) match.ts guard.ts(四级水位+标定) recovery.ts evict.ts
│   ├─ router/                    # ModelRouter.ts breaker.ts mode.ts candidates.ts pool.ts recon.ts
│   │                             #   alert.ts(账本先行) outbox.ts runtime.ts(槽位 sem)
│   ├─ governance/                # gate.ts(evaluate/decide/claim/resolveExecution/revoke/forceApproval)
│   │                             #   catalog.ts(zod) policy.ts review.ts(precheck/postReview/sanitize)
│   │                             #   memory-rules.ts(grants/rules) quarantine.ts audit.ts cron.ts
│   │                             #   channels/telegram.ts(阶段二接线位) status.ts(8态+TRANSITIONS 导出)
│   ├─ exec/                      # ExecService.ts fleet.ts(状态机+boot/reconcile/recreate) image.ts
│   │                             #   netguard.ts(iptables DOTD-OUT) disk.ts(DiskGardener)
│   │                             #   protocol.ts(ToolCall/ToolResult 与容器共用)
│   ├─ memory/                    # MemoryService.ts inject.ts(buildContextBundle/buildSessionReplay)
│   │                             #   seal.ts(WRITE-SEAL) limits.ts(beforeWrite) compaction.ts retention.ts
│   │                             #   fsops-client.ts(经 /fs/ops 桥) outbox-guard.ts
│   ├─ surfaces/                  # http.ts(7788 路由表+鉴权+HMAC) ingress.ts(webhook/JSONL normalize)
│   │                             #   sse.ts(bus_seq) heartbeat-tick.ts(算法，交付给 CP 注册)
│   │                             #   channels.ts(NotificationChannels 适配器) cli.ts(commander)
│   │                             #   web.ts(静态托管) telegram/ (阶段二)
│   └─ runner/                    # dot.ts —— LLM↔工具主循环协程（§12 骨架契约，CP §12 + 契约 §8 ⑤–⑪）
├─ agent-runtime/                 # 容器内 Node 服务（打进镜像）
│   ├─ server.ts  ledger.ts  browser.ts(BrowserHolder+stealth)  fs.ts(fs.* + /fs/ops 桥)
│   ├─ shell.ts(setuid 1001)  xvhfd.ts  package.json  tsconfig.json
├─ exec-image/Dockerfile          # §9.5
├─ web-ui/                        # Vite+React18：Chat/Queue/Approvals/Events/Models/Logs 六视图
├─ scripts/                       # wsl-bootstrap.sh(docker 组预检) · portproxy.ps1 · calibrate-watermark.sh
└─ tests/                         # node:test 集成：journal 崩溃矩阵 / 审批竞态 / route 降级脚本回放
```

### 9.2 SQLite 全量 DDL（按迁移执行顺序合并）

> 单一库文件 `~/.dotd/dotd.db`（契约 D1）；`PRAGMA journal_mode=WAL; synchronous=FULL; busy_timeout=5000` 由启动者设一次（D2）；`foreign_keys` 不全局 ON；**不建跨模块所有权外键**，点号注释标属主。以下即 `db/migrations/` 六个包的内容合并，已按契约逐条校正（改名 source_event_id/event_id、增 payload_json、events/crontabs 归 CP、删 surf_heartbeat_state、去 tg_card FK）。

```sql
-- ============ 000_control_plane.sql（属主：CP） ============
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;

-- 事件表（契约 E1：全系统唯一事件表；id INTEGER 自增，业务扩展进 payload 不加列）
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('http','file','heartbeat','telegram','email')),
  dot_id TEXT NOT NULL,
  actor  TEXT NOT NULL,
  dedup_key TEXT UNIQUE,                    -- NULL 允许：多条 NULL 互不冲突
  payload   TEXT NOT NULL,                  -- JSON
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','matched','ignored','inbox')),
  received_at INTEGER NOT NULL
);

-- 心跳定时（契约 H1：单表归 CP，原 surf_heartbeat_state 行为扩展列已并入）
CREATE TABLE crontabs (
  id TEXT PRIMARY KEY,                      -- 'ct_'+nanoid
  dot_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
  cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  next_fire INTEGER NOT NULL,               -- 入表即由 cron-parser 算好
  last_fired_at INTEGER,
  last_fire_seq INTEGER NOT NULL DEFAULT 0,
  last_fire_status TEXT,                    -- fired|skipped_quiet|skipped_busy|error
  skip_if_busy INTEGER NOT NULL DEFAULT 1,
  quiet_hours TEXT,                         -- '23:00-07:30' 本地时区
  catchup TEXT NOT NULL DEFAULT 'latest' CHECK (catchup IN ('latest','skip'))
);

-- 任务队列
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,           -- 'tk_'+base36 时间序+rand；事件任务='tk_ev_'+events.id
  dot_id        TEXT NOT NULL DEFAULT 'dot1',
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  payload_json  TEXT,                       -- 契约 E2：mem 维护任务等结构化载荷（CP 原稿缺列，已补）
  status        TEXT NOT NULL CHECK (status IN
                  ('queued','running','awaiting_approval','paused','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 5, -- 0 最高；1=主人 interactive，7=bulk
  run_at        INTEGER,
  source_event_id INTEGER,                  -- 弱引用 events.id（契约 E1 由 source_event_log_id 改名）
  session_id    TEXT,                       -- ≡ thread_id，弱引用 mem_threads.id
  thread_id     TEXT,                       -- 弱引用 mem_threads.id
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_epoch     INTEGER NOT NULL DEFAULT 0, -- 围栏：转 running +1（CP §2.2）
  last_heartbeat_at INTEGER,
  resume_from_seq   INTEGER,                -- 审批放行后从第 N 步续
  stop_reason   TEXT CHECK (stop_reason IN
                  ('user','tool_risk','circuit_open','watermark','budget','shutdown')
                  OR stop_reason IS NULL),
  budget_tokens INTEGER NOT NULL DEFAULT 200000,
  usage_tokens  INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_pop  ON tasks(dot_id, status, priority, run_at);
CREATE INDEX idx_tasks_live ON tasks(dot_id, status)
  WHERE status IN ('running','awaiting_approval','paused');
CREATE INDEX idx_tasks_done ON tasks(status, updated_at)
  WHERE status IN ('done','failed','cancelled');

CREATE TABLE task_results (                 -- 同属主 FK 允许（契约 D2）
  task_id  TEXT PRIMARY KEY REFERENCES tasks(id),
  summary  TEXT NOT NULL,
  ok       INTEGER NOT NULL
);

-- 步骤级 journal（崩溃安全核心）
CREATE TABLE steps (
  task_id     TEXT NOT NULL,                -- 同属主应用层约束，不建 FK 以免 VACUUM 摩擦
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('llm','tool')),
  status      TEXT NOT NULL CHECK (status IN
                 ('pending','started','succeeded','failed','interrupted','skipped')),
  call_id     TEXT,                         -- ULID；llm 步同样填写（契约 J1）
  tool_name   TEXT,
  args_json   TEXT,                         -- >32KB 走 journal-blobs/ 文件
  result_json TEXT,
  side_effect TEXT CHECK (side_effect IN ('safe','replayable','unknown')),
  run_epoch   INTEGER NOT NULL,             -- 写该步时的 epoch，审计可辨哪代 Runner
  approval_id INTEGER,                      -- 弱引用治理 approvals.id（仅 pending 步）
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (task_id, seq)                -- (task_id,seq) 内部排序键，不外泄为审批引用
);
CREATE UNIQUE INDEX uq_steps_call ON steps(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX idx_steps_open  ON steps(task_id, status) WHERE status IN ('started','pending');

-- 事件匹配决策（PK=events.id 天然幂等；契约 E1 列名 event_log_id→event_id）
CREATE TABLE event_decisions (
  event_id     INTEGER PRIMARY KEY,
  action       TEXT NOT NULL CHECK (action IN ('run_new','merge','ignore')),
  task_id      TEXT,
  confidence   REAL NOT NULL,
  reason       TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('rule','llm','manual')),
  decided_at   INTEGER NOT NULL
);

-- 背压/围栏/资源事件
CREATE TABLE resource_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('normal','guarded','throttled','halted')),
  kind   TEXT NOT NULL CHECK (kind IN
           ('watermark','container_pause','container_unpause','container_kill',
            'queue_evict','disk_gc','stale_writer','watchdog','budget')),
  detail TEXT NOT NULL
);

-- ============ 010_model_router.sql（属主：MR，八张，他模块只经 snapshot() 读） ============
CREATE TABLE breaker_state (
  endpoint_id     TEXT NOT NULL,
  track           TEXT NOT NULL CHECK (track IN ('primary','light')),
  state           TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  opened_at       INTEGER,
  next_probe_at   INTEGER,
  backoff_ms      INTEGER NOT NULL DEFAULT 60000,
  consec_failures INTEGER NOT NULL DEFAULT 0,
  half_open_ok    INTEGER NOT NULL DEFAULT 0,
  throttled_until INTEGER,
  last_kind       TEXT,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (endpoint_id, track)
);
CREATE TABLE breaker_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL, track TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  kind TEXT, latency_ms INTEGER, ts INTEGER NOT NULL
);
CREATE INDEX idx_bsample ON breaker_sample(endpoint_id, track, ts);
CREATE TABLE breaker_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL, track TEXT NOT NULL,
  from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  reason TEXT, ts INTEGER NOT NULL
);
CREATE INDEX idx_bevent_ts ON breaker_event(ts);
CREATE TABLE router_state (
  key TEXT PRIMARY KEY CHECK (key IN ('mode','emergency_active','primary_endpoint_id','mode_since')),
  value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE pool_probe_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  probe_kind TEXT NOT NULL CHECK (probe_kind IN ('health','tool_roundtrip')),
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  detail TEXT, ts INTEGER NOT NULL
);
CREATE INDEX idx_probe_ep ON pool_probe_result(endpoint_id, ts);
-- Tier4 侦察候选状态机：needs_approval→approved|rejected；approved→live|expired；
-- live→retired；expired/retired→needs_approval（复活）；rejected 30d 冷却
CREATE TABLE recon_candidate (
  id TEXT PRIMARY KEY,                       -- 'recon:'+sha1(source|base_url|model)[0:12]
  source TEXT NOT NULL,
  base_url TEXT NOT NULL, model TEXT NOT NULL,
  api_key_note TEXT,                         -- 需要什么凭证，绝不存 key 本身
  rate_note TEXT, evidence TEXT,
  state TEXT NOT NULL DEFAULT 'needs_approval'
    CHECK (state IN ('needs_approval','approved','rejected','live','expired','retired')),
  decided_by TEXT, decided_at INTEGER, reject_reason TEXT,
  found_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(base_url, model)
);
-- 求救去重账本（账本先行协议：投递前 INSERT pending）
CREATE TABLE alert_dispatch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,                   -- sha256(newMode|失败指纹|tier)
  kind TEXT NOT NULL CHECK (kind IN ('help','recovery','recon_proposal')),
  mode TEXT NOT NULL,
  failing_json TEXT NOT NULL,
  served_by TEXT,
  task_impact TEXT,                          -- {queued_primary,running,held}（契约 T2 snake_case）
  channels_tried TEXT NOT NULL,
  delivered_via TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivered_via IN ('pending','telegram','email','outbox','none','lost')),
  sent_at INTEGER NOT NULL, delivered_at INTEGER, resolved_at INTEGER
);
CREATE INDEX idx_alert_sig ON alert_dispatch(signature, resolved_at);
-- 路由调用记账（attempt_id='nonj:'+ULID 为非 journal 调用，契约 J1）
CREATE TABLE model_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL, attempt_seq INTEGER NOT NULL,
  event_id TEXT, track TEXT NOT NULL,
  endpoint_id TEXT NOT NULL, model TEXT NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('ok','fail','breaker_skip','throttle_skip','half_open_busy_skip','stream_broken')),
  kind TEXT, latency_ms INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, ts INTEGER NOT NULL
);
CREATE INDEX idx_call_attempt ON model_call_log(attempt_id);
CREATE INDEX idx_call_ts ON model_call_log(ts);

-- ============ 020_governance.sql（属主：GOV，库路径经 DOTD_DB_PATH 注入 = dotd.db） ============
CREATE TABLE gov_seq (
  name TEXT PRIMARY KEY,                     -- 'approval'
  value INTEGER NOT NULL DEFAULT 0           -- INSERT 同事务 UPDATE+RETURNING；豁免 90d 清理
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,                    -- rowid 可复用；展示与 TG 寻址一律用 seq（AP-#<seq>）
  seq INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'tool_call' CHECK (kind IN ('tool_call','synthetic','question')),
  subject_key TEXT,                          -- 非工具单幂等键（'recon:…'/'unk:'+callId）
  subject_json TEXT,
  dot_id TEXT NOT NULL, task_id TEXT NOT NULL, event_id TEXT,
  journal_step TEXT,                         -- == ToolCall.callId == steps.call_id（契约 J1）
  tool TEXT,
  tier TEXT CHECK (tier IN ('read','write_file','browser','spend','dangerous')),
  params_json TEXT NOT NULL,                 -- sanitize 后
  summary TEXT NOT NULL,                     -- ≤120 字卡片文案
  reason TEXT NOT NULL,
  risk_brief TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired','executing','executed','failed','revoked')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  pending_until TEXT NOT NULL,               -- created_at + TTL=24h（契约 G2 定稿）
  reminded_at   TEXT,                        -- 过期前 1h 提醒一次后回填
  decided_at TEXT,
  decided_by TEXT CHECK (decided_by IN ('web','telegram','cli') OR decided_by IS NULL),
  note TEXT,                                 -- 主人补充指令 ≤500 字符
  tg_message_id INTEGER, batch_ref TEXT,     -- 同任务批量卡片合并
  final_params_json TEXT,                    -- 认领时固化
  CHECK (kind != 'tool_call' OR (tool IS NOT NULL AND tier IS NOT NULL AND journal_step IS NOT NULL))
);
CREATE INDEX idx_approvals_pending ON approvals(status, pending_until) WHERE status='pending';
CREATE INDEX idx_approvals_step    ON approvals(journal_step);
CREATE UNIQUE INDEX uniq_open_step ON approvals(journal_step)
  WHERE kind='tool_call' AND journal_step IS NOT NULL
        AND status IN ('pending','approved','executing');   -- 同一步至多一张活动单
CREATE UNIQUE INDEX uniq_open_subject ON approvals(subject_key)
  WHERE subject_key IS NOT NULL AND status IN ('pending','approved','executing');
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,                       -- 'dec_'+ULID，每次 evaluate 出口先落库
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id TEXT NOT NULL, task_id TEXT NOT NULL,
  journal_step TEXT, call_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('allow','review_pass','approve','deny')),
  tier TEXT, tool TEXT, params_json TEXT, reason TEXT,
  review_skipped INTEGER NOT NULL DEFAULT 0, -- §5.1.2 降级放行标记
  from_memory INTEGER,
  approval_id INTEGER REFERENCES approvals(id),   -- 同属主 FK 允许
  precheck_json TEXT,
  postreview TEXT CHECK (postreview IN ('ok','suspicious','quarantine') OR postreview IS NULL),
  postreview_json TEXT,
  injection_suspect INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_decisions_step ON decisions(journal_step, ts);
CREATE TABLE approval_rules (
  id INTEGER PRIMARY KEY, dot_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('read','write_file','browser')),  -- spend/dangerous 禁入
  rule_key TEXT NOT NULL, matcher TEXT NOT NULL, text TEXT NOT NULL,
  source_approval INTEGER NOT NULL REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT
);
CREATE UNIQUE INDEX uniq_rule ON approval_rules(dot_id, tier, rule_key) WHERE status='active';
CREATE TABLE endpoint_grants (
  id INTEGER PRIMARY KEY, dot_id TEXT NOT NULL,
  origin TEXT NOT NULL, path_glob TEXT NOT NULL DEFAULT '/*',
  tier_ceiling TEXT NOT NULL CHECK (tier_ceiling IN ('read','write_file','browser')),
  source_approval INTEGER NOT NULL REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dot_id, origin, path_glob, tier_ceiling)
);
CREATE TABLE quarantines (
  id INTEGER PRIMARY KEY, dot_id TEXT NOT NULL, reason TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  approval_id INTEGER REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  lifted_by TEXT, lifted_at TEXT
);
CREATE UNIQUE INDEX uniq_quarantine ON quarantines(dot_id) WHERE status='active';
CREATE TABLE audit_log (                     -- 只追加；action 枚举不加 CHECK（增枚举免迁移）
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id TEXT, task_id TEXT, journal_step TEXT, decision_id TEXT, approval_id INTEGER,
  actor TEXT NOT NULL,                       -- 'agent'|'owner'|'system'
  channel TEXT CHECK (channel IN ('web','telegram','cli','system') OR channel IS NULL),
  action TEXT NOT NULL, tier TEXT, tool TEXT, decision TEXT, reason TEXT,
  details_json TEXT, details_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_ts   ON audit_log(ts);
CREATE INDEX idx_audit_task ON audit_log(task_id, ts);
CREATE INDEX idx_audit_step ON audit_log(journal_step);
CREATE INDEX idx_audit_dec  ON audit_log(decision_id);
CREATE TABLE audit_archive (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL,
  min_id INTEGER NOT NULL, max_id INTEGER NOT NULL,
  min_ts TEXT NOT NULL, max_ts TEXT NOT NULL,
  rows INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE spend_ledger (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id TEXT NOT NULL,
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  decision_id TEXT REFERENCES decisions(id),
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,             -- charge 正 / void 负
  currency TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('charge','void','adjust')),
  note TEXT
);

-- ============ 030_execution.sql（属主：EX） ============
CREATE TABLE exec_dots (
  dot_id TEXT PRIMARY KEY,                   -- 阶段一恒 'dot1'；无 dots 表（契约 D2 裁定）
  runtime_ver TEXT NOT NULL,                 -- 参与镜像 tag；增删工具 bump
  limits_json TEXT NOT NULL,                 -- 配额唯一事实源 {memMb:1536,cpuMillis:2000,…}（契约 J5）
  idle_timeout_s INTEGER NOT NULL DEFAULT 900,
  deep_stop_after_s INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE image_builds (                  -- 镜像全局唯一，无 dot 维度
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL, digest TEXT, pw_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','ready','failed','superseded')),
  log_tail TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id TEXT NOT NULL REFERENCES exec_dots(dot_id),   -- 同属主 FK
  docker_container_id TEXT,
  state TEXT NOT NULL CHECK (state IN
   ('absent','image_ready','created','booting','ready','busy','idle',
    'suspended','idle_stop_requested','stopped','quarantined',
    'unhealthy','create_failed','build_failed','removed','lost')),
  endpoint TEXT,                             -- http://IP:9223
  token_hash TEXT,                           -- 明文 token 只存 ro-bind 文件，不落库
  last_health_at TEXT, last_busy_at TEXT,
  recreate_count INTEGER NOT NULL DEFAULT 0, -- >3/24h → quarantined
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_containers_state ON containers(state);
CREATE UNIQUE INDEX ux_containers_active_dot ON containers(dot_id)
  WHERE state NOT IN ('removed','lost');     -- 挡双活跃行（NULL≠NULL 教训的修正版）
CREATE TABLE exec_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id TEXT NOT NULL REFERENCES exec_dots(dot_id),
  identity_key TEXT NOT NULL,                -- 语义身份名；登录态审计落此
  profile_hash TEXT NOT NULL,                -- sha256(identity_key)[0:16]，目录名用 hash
  last_used_at TEXT,
  UNIQUE (dot_id, identity_key)
);
CREATE TABLE exec_volumes (                  -- DiskGardener 防误删白名单
  name TEXT PRIMARY KEY,                     -- dot-<id>-home / -profiles / -state
  dot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home','profiles','state')),
  quota_mb INTEGER NOT NULL, usage_mb INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE exec_calls (                    -- journal 步的协议层投影（call_id 对齐，无跨模块 FK）
  call_id TEXT PRIMARY KEY,
  job_id TEXT,                               -- async 回执：对账续轮询与 cancel 的键
  task_id TEXT NOT NULL, dot_id TEXT NOT NULL, tool TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sync','async')),
  args_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sent','running','done','error','cancelled','interrupted')),
  result_hash TEXT, error_code TEXT,
  sent_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX idx_exec_calls_task ON exec_calls(task_id);
CREATE INDEX idx_exec_calls_open ON exec_calls(state) WHERE state IN ('sent','running');
CREATE INDEX idx_exec_calls_job ON exec_calls(job_id) WHERE job_id IS NOT NULL;
CREATE TABLE exec_disk_policy (
  key TEXT PRIMARY KEY, value_mb INTEGER NOT NULL, updated_at TEXT NOT NULL
);

-- ============ 040_memory.sql（属主：MEM） ============
CREATE TABLE mem_threads (                   -- thread ≡ session（契约 M1）
  id TEXT PRIMARY KEY,                       -- 'thr_'+ULID
  dot_id TEXT NOT NULL DEFAULT 'dot1',
  channel TEXT NOT NULL CHECK (channel IN ('web','telegram','cli','email','event','heartbeat')),
  external_ref TEXT,                         -- 幂等域：当前仅 telegram=chatId；web/cli/event NULL（MEM Q3）
  title TEXT,
  origin_task_id TEXT,                       -- event/heartbeat 幂等锚
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','sealed','purged')),
  pinned INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT, context_summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL,
  last_task_finished_at INTEGER,             -- sealTask 写入 = 封存/断点扫描锚
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mem_threads_dot  ON mem_threads(dot_id, last_active_at DESC);
CREATE INDEX idx_mem_threads_task ON mem_threads(origin_task_id) WHERE origin_task_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mem_threads_ext ON mem_threads(channel, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE TABLE mem_messages (
  id TEXT PRIMARY KEY,                       -- 'msg_'+ULID
  thread_id TEXT NOT NULL REFERENCES mem_threads(id) ON DELETE CASCADE,  -- 同属主，写入顺序自律
  seq INTEGER NOT NULL,                      -- 每 thread 从 1 单调，同事务 max+1
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  kind TEXT NOT NULL CHECK (kind IN
    ('text','tool_call','tool_result','approval_request','approval_verdict',
     'task_start','task_end','memory_note','system_error')),
  content TEXT NOT NULL,                     -- text=全文（恢复责任在此）；tool_*=digest+200 字预览
  task_id TEXT, event_id TEXT,               -- 弱关联，无外键（契约 S3）
  token_est INTEGER NOT NULL,                -- chars/3.5 估算
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX idx_mem_messages_thread ON mem_messages(thread_id, seq);
CREATE INDEX idx_mem_messages_task   ON mem_messages(task_id) WHERE task_id IS NOT NULL;
CREATE TABLE mem_files_index (               -- home 只读镜像；范围 MEMORY.md+notes+manuals，
                                             -- 排除 .archive/.tmp/.dotd
  dot_id TEXT NOT NULL, path TEXT NOT NULL,  -- HomeRelPath 唯一域
  area TEXT NOT NULL CHECK (area IN ('memory','notes','manuals')),
  tags TEXT, title TEXT,
  size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  PRIMARY KEY (dot_id, path)
);
CREATE TABLE mem_maintenance_state (         -- 游标/kv：compact_due:<dotId>、retention_last_run、
                                             -- index_sync_last、payload:<specId>、search_stats、purge_ledger
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
-- FTS5 预留（§6.4 信号触发再启用）：
-- CREATE VIRTUAL TABLE mem_messages_fts USING fts5(content, content='mem_messages', content_rowid='rowid');

-- ============ 050_surfaces.sql（属主：SF） ============
CREATE TABLE surf_jsonl_offset (
  path TEXT PRIMARY KEY, inode INTEGER NOT NULL,
  gen INTEGER NOT NULL DEFAULT 0,            -- 旋转代数，参与 dedup_key
  byte_off INTEGER NOT NULL,                 -- 只停完整行边界
  updated_at TEXT NOT NULL
);
CREATE TABLE surf_tg_card_state (            -- 通道侧事实；无 REFERENCES（契约 D2 去跨模块 FK，
                                             -- surf_heartbeat_state 已整表作废并入 crontabs）
  approval_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  reminded_at TEXT
);
CREATE TABLE surf_ingress_rejects (          -- 从未抵达 CP 的入站失败审计
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  source TEXT NOT NULL, actor TEXT,
  reason TEXT NOT NULL CHECK (reason IN
    ('auth','origin','rate','schema','size','allowlist','parse')),
  detail TEXT
);
CREATE TABLE surf_sse_cursor (
  k INTEGER PRIMARY KEY CHECK (k = 1), seq INTEGER NOT NULL
);
```

**迁移 runner 约定**：CP `db/migrate.ts` 为唯一执行者——启动时读 `PRAGMA user_version`，按注册顺序执行未应用的包、每包一事务、成功后 `user_version=N`；任何失败 → **拒绝启动 + 向 `~/.dotd/OUTBOX.md` append HELP 块**（CP §7.1 / MEM §6.3 同级）。之后 `integrity_check`、之后各模块才能 init。

### 9.3 审批状态机（实施图，GOV §3.2 + 契约 G2 定稿）

```
                          ┌──────────┐
   insertApproval ──────▶ │ pending  │  TTL = created_at + 24h（pending_until）
   （evaluate approve /   └────┬─────┘   过期前 1h reminded_at 回填只提一次
    forceApproval /        ┌───┼───────────────┬────────────┐
    synthetic/question）   ▼   ▼               ▼            ▼（cron expirePending 每5min）
                    ┌────────┐ ┌─────────┐ ┌────────┐  ┌─────────┐
                    │approved│ │rejected │ │revoked │  │ expired │ ← 过期即终局，不可复活
                    └───┬────┘ └─────────┘ └─────────┘  └─────────┘   （"重做"=新调用产生新单）
              claim CAS │  ▲ revoke（仅未认领时；revoke 抢先→settle ok=false+revoke:'pre-claim'）
             （执行面）  ▼  │
                    ┌───────────┐   resolveExecution(ok)   ┌──────────┐
                    │ executing │ ───────────────────────▶ │ executed │（终）
                    └─────┬─────┘                          └──────────┘
                          │ resolveExecution(err) → ┌────────┐
                          │  （executing 后不可 revoke，  │ failed │（终；只记审计+spend void 冲账）
                          │    安全边界在认领前）        └────────┘
  TRANSITIONS = { pending:[approved,rejected,expired], approved:[executing,revoked],
                  executing:[executed,failed], 其余:[] }   // 非法迁移 throw + 审计 illegal_transition
  Verdict（人输入） = approve_once | approve_remember | reject；TG 禁 remember
  幂等三件套：uniq_open_step(journal_step) · uniq_open_subject(subject_key) · gov_seq
  重入语义：同 callId 活动单 → pending 原样返回/approved claimAndAllow/executing deny 竞态；
            终态单 → deny + reentry_after_terminal 审计（控制面不得重放终态步）
  联动：decide/expire/revoke 事务提交 → 调用栈内 cp.onApprovalSettled(taskId,apId,ok,meta)
        ok → 任务 queued(resume_from_seq) 以原 callId 复用执行；deny/expired → journal.skipStep
```

### 9.4 ModelRouter 状态机（实施图，MR §4.1/§4.3 + 契约 T1）

**(a) 熔断器（每 endpoint×track 一实例，状态落 breaker_state 重启不丢）**

```
          失败率≥0.5（窗口≥5 样本）或连败≥3 或 quota（起步 30min）或 auth（不自动恢复）
 closed ────────────────────────────────────────────────▶ open
   ▲                                                       │ next_probe_at 到期（退避 60s 起×2 ≤1h）
   │ half_open_ok≥2（真实流量优先承担探活；无流量 light 发 8tok ping、 │
   │ primary 不合成探活——工具质量验不了）                            ▼
   └──────────────── half_open ◀───── 放行 1 个在途（第 2..N 个 half_open_busy_skip 跳后）
                          │ 任一失败 → open（backoff ×2）
 特例：429 无 quota 文案且 Retry-After≤120s → 不 open，throttled_until 软冷却、窗口记 ok；
       Tier2 单次 busy 不入窗，连续 busy≥3 → engine_unavailable 入窗（起步退避 5min）；
       Tier3 health 失败 → pool_unverified（起步 60s）；auth 半开仅配置 reload 后允许。
```

**(b) 全局 mode（单实例，落 router_state，与 emergencyActive 同事务）**

```
 NORMAL ◀───────────────────────────┐ 任一 tier1×primary 回 closed
   │ 全部 tier1 primary open         │
   ▼                                 │
 LOCAL_FALLBACK（tier2 可服务）        │  tier2 light 正常；primary 挂起=任务
   │ tier2 也不可用                   │  paused(circuit_open)，除非 models.yml 显式授权
   ▼                                 │  tier2.primary（degraded:true 审查加验）
 EMERGENCY（tier3 池承载，emergencyActive=true，收缩生效）
   │ 无 tool-qualified 池模型          │  light 仍可用则
   ▼                                  ▼
 RESTRICTED（primary 停摆，light 尽力，emergencyActive=true）
   │ 全挂
   ▼
 TOTAL_OUTAGE ──▶ 每 6h 侦察 + 每 6h 对挂起任务真实重试
 变差 → maybeSendHelp()（签名 24h 去重，账本先行）；变好 → sendRecovery()（多行合并收敛）
        + CP 订阅 router.mode_changed 批量把 paused(circuit_open) 任务回 queued
```

### 9.5 每 Dot 容器 Dockerfile 草案（EX §3.1 原文修订版，落 `exec-image/Dockerfile`）

```dockerfile
# 基座：Playwright 官方镜像（浏览器+依赖就绪），双版本锁定；全局唯一镜像，身份差异在卷里
ARG PW_VERSION=1.49.1-noble          # 与 agent-runtime package.json 的 playwright 严格同版本
FROM mcr.microsoft.com/playwright:v${PW_VERSION}-noble

# headed 模式依赖：官方镜像不自带 Xvfb（由 agent-runtime 启动时自行 spawn :99，非 init 进程）
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb bash \
    && rm -rf /var/lib/apt/lists/*

# agent-runtime 源码经宿主 daemon 内存 tar 流构建（不落镜像仓库）
COPY agent-runtime/ /opt/agent-runtime/
# tsc 属 devDependency：两阶段处理，先带 dev 编译再 prune
RUN cd /opt/agent-runtime \
    && npm ci --include=dev \
    && ./node_modules/.bin/tsc -p . \
    && npm prune --omit=dev

# 非 root 运行 + 显式预建挂载点并 chown——否则 Docker 以 root 建卷挂载点，
# 容器内 USER dot(1000) 无法写 home/profiles/state（笔记/ledger/token 全失败）
# shell 子进程专用 uid 1001（§9.6 秘密隔离；依赖 CapAdd SETUID，实施首日实测，开放问题 Q7）
RUN useradd -m -u 1000 dot \
    && useradd -M -u 1001 shell \
    && mkdir -p /dot/home /dot/profiles /opt/agent-state /run/dotd \
    && chown dot:dot /dot /opt/agent-state /run/dotd && chmod 700 /opt/agent-state \
    && chown -R dot:dot /opt/agent-runtime
USER dot
ENV HOME=/dot/home PLAYWRIGHT_BROWSERS_PATH=/opt/playwright DISPLAY=:99
VOLUME ["/dot/home", "/dot/profiles"]     # state 卷与 token bind 在容器创建参数里挂
EXPOSE 9223
ENTRYPOINT ["node", "/opt/agent-runtime/dist/server.js"]
```

运行时容器参数要点（HostConfig，完整伪码见 EX §4.2）：`NetworkMode:'dotd'`(ICC off)；`Memory=1536MB=MemorySwap`（禁 swap）；`NanoCpus=2e8`（2000m）；`PidsLimit 512`；`ReadonlyRootfs` + tmpfs `/tmp 256m`；`CapDrop:[ALL], CapAdd:[SETUID,SETGID]`；`SecurityOpt:[no-new-privileges:true]`；`OomScoreAdj:700`；`RestartPolicy:'no'`（由 EX 状态机监督）；Binds：`dot1-home:/dot/home`、`dot1-profiles:/dot/profiles`、`dot1-state:/opt/agent-state`、`/var/lib/dotd/tokens/dot1.token:/run/dotd/token:ro`。

### 9.6 依赖清单

**宿主 daemon（npm deps）**

| 包 | 用途 | 备注 |
|---|---|---|
| better-sqlite3 | 单库同步事务 | 全系统唯一连接（契约 D2） |
| dockerode | WSL unix socket 容器编排 + stats API | 替代 docker CLI 子进程（契约 J5） |
| zod | 配置/入口/工具目录校验 | 非法即拒启动 |
| chokidar | JSONL 文件监听 | 阶段一接口定型默认关 |
| cron-parser | crontabs next_fire | SF/CP 同一库 |
| commander | CLI | 只经 7788 HTTP |
| playwright（宿主侧仅 types） | 协议类型共享 | 浏览器二进制只在镜像内 |
| Node 24 内置：http/https、fetch(undici)、node:test、child_process(仅 iptables/xvfb 无)、fs | — | 求救 SMTP 用原生或 nodemailer（阶段二） |

**agent-runtime（镜像内）**：playwright@1.49.1（严格锁）、playwright-extra + puppeteer-extra-plugin-stealth（evasions，版本锁进 lockfile）、express 不需要（Node http 自写路由）、其余同上 zod/ulid。

**系统层**：WSL Ubuntu-24.04 + dockerd 29.1.3（API 1.52 实测）+ iptables（HostNetGuard 预检 fail-fast）；镜像基座 apt：xvfb、bash；`.wslconfig` memory=32GB/processors=24；Windows portproxy 脚本。

### 9.7 两周里程碑拆分（单人）

| 日 | 交付 | 验收 |
|---|---|---|
| D1 | 脚手架 + **两项必测前置**：WSL `docker pause` 可用性、state 卷 setuid(1001) 方案；db 层：单连接 PRAGMA、迁移 runner、39 表 DDL 落库 | `dotd serve` 起、user_version=50；两测结论回填文档 |
| D2 | CP：tasks/steps DDL 类型化、submit/队列 pop（谓词与配置值按 §2 决策 3 与 §2 接口定稿表：`maxRunningTasks=1`、`heartbeatTimeoutMs` 取 R5 过渡值、`maxQueued=200`，全为配置项）/epoch 围栏/心跳超时看门狗/finish-cancel；集成测试骨架 CP §12 起步 | 双协程迟到写被拒记 stale_writer；未到期 `run_at` 任务不被领取 |
| D3 | journal 全量：beginTool/endTool/markPending/beginLlm→{seq,callId}/skipStep/resolveOpenStep 三分流 + blob 截断 | 崩溃矩阵测试（§8.2 逐格）绿 |
| D4 | EX：镜像构建、HostNetGuard、容器状态机 + boot/reconcile；agent-runtime：ledger、/tools/call、/jobs/*、/calls/*、fs.* | recreate 后 done 调用取回不重派 |
| D5 | EX 续：shell.run（setuid 后方案）、browser.open/act/snapshot/close、BrowserHolder + profile 卷；ExecService.getContainerStats；**`setIdentityProfile` 接线 + `exec_identities` 引导期落一行 + 首登通道（§5"阶段一身份链路"小节，B16 定夺后执行）** | 容器内开站截图、shell 读不到 token/ledger、身份行存在且 profile 目录懒建 |
| D6 | MR：端点加载、breaker、mode、双轨 complete、Tier1→2 降级、nonj attemptId、model_call_log | 拔网线演练：AllEndpointsDown→paused(circuit_open) 语义 |
| D7 | MR 续：Tier2 三道闸（Colibrì health/warm/槽位/busy 三连入窗）、流式首字节语义、OUTBOX 账本先行 + 恢复通报 | 求救 24h 去重实测（改系统时钟或注入签名） |
| D8 | GOV：catalog zod 加载、五档 evaluate、G1 顶层 identity 谓词、upgrade、spend 契约、decisions 落库 | 未登记工具 deny、**登录态恒 approve 用例（合成 ToolCall{tool:'browser.*', identity 非空} 直调 evaluate 即可，不依赖真实 cookies——故不卡 B16）** |
| D9 | GOV 续：approvals 8 态 + decide 先到先得 + late_decision、expirePending/提醒 cron、forceApproval(synthetic)、audit 写入 | 双通道并发 decide 竞态测试 |
| D10 | SF：7788 监听、鉴权/HMAC/Origin、/api/* 转调 CP/GOV、SSE bus_seq + resync、CLI 全套 | CLI ask→approval→approve 闭环 |
| D11 | SF 续：webhook 入口 + dedup、crontabs 表 + heartbeat.tick（先推进后投递）、Web UI 骨架（聊天/队列/审批卡片三视图） | 崩溃窗口漏/补发心跳行为符合 catchup |
| D12 | MEM：mem_* 读写、buildContextBundle/buildSessionReplay、sealTask 挂全部终态收口点、beforeWrite 限额、/fs/ops 客户端 + 索引对账 | 恢复链：LLM 全文来自 thread、工具全文从 steps 回填 |
| D13 | Runner 主循环全接线（§8 走查 12 段）+ 端到端集成 + 四级水位背压联调（标定模式）+ 磁盘回收 cron 全注册 | 一条真实 webhook→审批→浏览器操作→回复全流程（登录态段以 D5 身份链路任一可用通道为准，通道全不可用则按 §11.3 锚① 退化条款执行） |
| D14 | 缓冲：崩溃演练（对每阶段 kill -9 daemon/容器）、文档修订回写契约 §10 待改清单、MVP 验收清单 | §8.2 崩溃表逐格实测签字 |

**阶段一明确不做**（留接口/配置占位）：Telegram、email 发送器（available=false）、JSONL 默认关、免费池实接入（recon/probe cron 在位、池空）、多 Dot、approve_remember 派生规则入库（表结构在、按钮 UI 阶段一可后置）、审查降级矩阵的自适应调参。

---

## 10. 阶段二 / 阶段三路线

### 10.1 阶段二（接口阶段一已定型，主要是接通与调优）

| 项 | 内容 | 涉及模块 |
|---|---|---|
| Telegram 全量 | getUpdates 长轮询、审批双通道（resolveTelegram/renderTgNotice）、批量卡片、reminded_at 防重 | SF §5.5 |
| 邮件入口 | email source 入 events 枚举（已预留）、IMAP/SMTP 适配器 + 附件策略 | SF + CP |
| 低智能分流实装 | Colibrì/Ollama 承接 event.match/摘要/precheck；`memory.*` 前缀入 light_events；本地不可靠→探测→再降级闭环 | MR + GOV 审查 |
| 免费池 + 侦察 + 求救闭环 | pool.probe 30min、tool_roundtrip 合格证、recon.scan 6h（api.github.com/openrouter 元数据）、候选审批卡片（synthetic recon_candidate）、TG 优先求救链路 | MR + GOV |
| 审批规则持久化 | approve_remember→endpoint_grants/approval_rules 派生+预览+LRU+记忆页；emergency 下 browser 记忆休眠 | GOV |
| email 兜底通道 | SMTP 适配器（SF 认领，nodemailer/native）；先做一次真实发送测试（MR 开放 #3） | SF + MR |
| 审查降级矩阵调参 | reviewDegraded 熔断阈值、批量卡片合并、postReview 嗅探正则集 | GOV |
| JSONL 监听默认开 | gen 旋转 dedup、错误行旁路 | SF |
| scheduled turns 增强 | quiet_hours 精细、补投策略 | SF/CP |

### 10.2 阶段三

- **多 Dot**：`dots` 主档表（配额分桶、跨 Dot 身份路由——契约 :35 阶段三项；单 Dot 身份登记 `exec_identities`+`setIdentityProfile` 已在阶段一交付，见 §1.4 注与 §5 身份链路）、按 dotId 分桶并发、`pauseDotQueue` 全量启用、profile 卷多 Dot 亲和调度（EX Q3）、hooks/jsonl 的 dot_id 路由表（SF Q8）、跨 Dot 记忆共享→触发向量库判据④（MEM §6.4）。
- **invisible_playwright 反检测增强**：stealth 注入实现替换（协议不动，EX §6.1）、`injection_suspect` 持久列作为数据源（GOV §5.2）。
- **语音**：明确最后做（CT:53）。
- 附带的机制升级：merge"立刻打断"通道（CP 开放 #2）、note 附条件强制执行（GOV §3.3）、`dotd notes backup`（MEM）、web session key 启用 thread 幂等（MEM Q3）、docker.sock 最小权限代理（EX Q1）。

---

## 11. 风险清单与需要主人拍板的开放问题

### 11.1 风险清单（按影响排序，全部来自本会话所读文档）

| # | 风险 | 影响 | 现有设计缓解 | 残余动作 |
|---|---|---|---|---|
| R1 | **state 卷 setuid 方案不成立**（EX Q7：uid 1000 的 Node 进程 spawn uid 1001 依赖 CapAdd SETUID，未实测） | shell 与秘密隔离整体崩塌 | 退路已备（setpriv 文件 cap / runtime root 启动后降权 fork） | **D1 首实测**；失败即回评审重定方案 |
| R2 | **WSL2 docker pause 不可用**（CP 开放 #1，cgroup-freezer 未实测） | throttled/guarded 让渡内存变慢，背压降级 | 退化方案已定："仅停 pop、idle 容器不 pause" | D1 实测并定夺是否接受降级 |
| R3 | **水位阈值假设 netfuzz 在 WSL 内**（CP 开放 #3：若实际在 WSL 之外，兜底线全盘错误） | 永久 throttled 或过度乐观 OOM | 首启标定模式 + base 低于预留走求救而非静默降级 | 主人确认 netfuzz 确位；标定后回填 |
| R4 | **TTL=24h × run_at × maxRunning=1 的定时任务饿死**（本次合并审读发现，见 D-1 条） | 心跳任务可能永不 pop | — | 实施时在 pop 加 run_at 老化提升或到期直送 |
| R5 | **看门狗超时与在途调用盲区**（本次读者意见 F3：公式输入全部落到磁盘数值——① routerTimeout：一次 `route()` 的**总预算** primary 300s / light 60s（MR §4.2:419-424 `deadline ?? 轨默认`），一圈扫所有端点**受总预算封顶**，"×重试"不乘端点重试次数；② 任务级 `max_attempts=3` 是步与步之间的 reclaim 轮次，与单步超时无关；③ toolTimeout = async 工具全局 deadline 上限 **30min**（EX §10:513/Q5:633，此数本身待 B14 确认）；④ 盲区根源：CP §12 骨架 heartbeat **只在步尾写**，`beginTool→endTool`/`beginLlm→endLlm` 在途期间 `last_heartbeat_at` 静止。故磁盘稿 CP:629 的 180s **必然慢性误回收**（300s LLM 步与 30min 工具步都会触发）） | 无谓 reclaim、attempt 膨胀、在途调用被 abort（epoch 围栏与 ledger 保数据不损坏，但浪费） | epoch 围栏保证不损坏数据；exec ledger 防重复执行 | **过渡值 `cfg.heartbeatTimeoutMs = 1_860_000`**（= 最长大步 1800s + 扫描周期 10s + 宽限 50s 取整；若 B14 把 async deadline 上限改小则同式重算），由上述磁盘数值直接推出）；代价：真卡死协程占用 maxRunning=1 约 32min 才被回收，单人单任务 MVP 可接受。**替代方案**（步内续跳：Runner 在 await runTool/complete 期间每 30s 只 UPDATE last_heartbeat_at）可把值缩回 90–120s，但**六份原文与契约均无此机制、属小幅新增设计**——并入 B13 由主人定夺 |
| R6 | 免费池与主通道**相关性故障**（OpenRouter 挂时 groq `:free` 也要同家 key，MR 开放 #2） | Tier3 对 tier1 故障失效、容灾名存实亡 | 池可现测资格、侦察多源 | 主人决策：独立 `:free` key/至少一家非 OR 池 |
| R7 | **阶段一求救只有 OUTBOX.md 一条路**（TG/email 皆阶段二）且 daemon 崩溃时无处可写（MR 边界） | 深夜全灭时求救可能无人见 | 账本先行 + 启动对账补投；文件可被外部监听 tail | 主人接受度确认；建议配 cron/看门狗 tail 提醒 |
| R8 | **Colibrì 内存吃紧时半死**（CT:36）：health 通过但驻留未完成、响应 30s+ | precheck/match 拖垮、审批洪水 | warm 判据+宽限期、busy 三连强制入窗、治理审查器自身熔断降级矩阵 | 标定日实测 precheck 850tok prefill 延迟，必要时调 45s 预算 |
| R9 | C:/D: 盘小叠加 WSL vhdx 不缩：镜像、三卷、dotd.db、audit-archive、journal-blobs 各有上限但**无全局总预算** | 宿主盘满连带 dockerd 挂 | DiskGardener free<5GB 触发、各表 TTL | 阶段一验收加"全链路 du 基线 + 每周 df 自检事件" |
| R10 | 侦察路径网络先例：github.com/huggingface.co 直连超时（MR 头注实测） | Tier4 全盲 | 已绕：api.github.com base64 + hf-mirror 人工参考 | 实现期正则/源不可达时 help 附注（MR §4.6-7） |
| R11 | **两周单人范围紧**：六模块 + 容器 + 审查矩阵全在 MVP（CT:51） | 延期或降质 | §9.7 已按"接口定型+实装裁剪"排程；TG/池/规则持久化后移 | 主人确认 §9.7 的裁剪清单即 MVP 验收线 |
| R12 | post-review/precheck 依赖本地低智能质量，行协议解析歧义 | 审查失效或误隔离 | 后审永不 fail-open 为 ok；行协议 `S|R|理由≤20字` | 实现期建误判样本集 |
| R13 | 单连接 SQLite 全模块共享：任何一段同步长查询阻塞 event loop（GOV 归档 DELETE、MEM LIKE） | 心跳延迟、SSE 卡顿 | WAL + 查询均限 O(index)/小表；归档分批 | 集成测压：audit 20k 行 + messages 10k 行下 pop 延迟 |

### 11.2 开放问题合并去重（六模块 + 契约 §11）

> 去重说明：各文档同题项已并条——"CP#5=GOV-O5=MEM 库路径/审批流水"、"SF-Q0=CP-S9 端口"、"MR 11 条=CP-S8 错误名"、"GOV-O1=SF-Q4 复活"、"GOV-O3=SF TTL"、"MR 5=CP-S8 waiting_model" 均已被接缝契约关闭，不再列示。

**A. 已裁定、需主人知悉背书（契约已裁，此处仅登记）**：G2 过期终局不复活；G2 TTL=24h；G1 登录态顶层 identity；D1 单库路径；H2 监听 7788；H1 crontabs 单表；J4 registerInternalJob 唯一 cron 宿主；T3 OUTBOX=~/.dotd/OUTBOX.md 块格式；M2 bindSession 唯一回写；M3 sealTask 全覆盖；M5 工具五词表；S-1 三分投递；S-2 gov.decide 唯一裁决写路径。GOV 的 O2/O4/O9 契约确认现设计值为终稿默认（spend 永不入记忆、单主人、executing 后不可 revoke）——若主人口味不同即翻案，否则不再议。

**B. 需主人拍板（产品口味/取舍，无法从文档推定）**

1. **LOCAL_FALLBACK 下是否授权 7B 降格跑主循环**（MR 开放 5，现默认挂起等恢复）：对少数低风险任务接受 `degraded:true` 加验降智执行？
2. **half_open_busy 对 primary 的默认**（MR 开放 7，现默认"跳过不等待"）：恢复瞬间首任务宁可落降级链，还是排队等探活 ≤15s？
3. **免费池 key 策略**（MR 开放 2，R6）：备独立 OpenRouter `:free` 专用 key / 只收非 OR 池 / 维持现状？
4. **spend 记忆额度**（GOV O2 现"永不"）：要不要"月度额度内充值免审批"？
5. **`approve all` 边界**（GOV O7）：现 tier≤browser 且非 emergency；是否改按规则键白名单化？
6. **审计超窗归档体验**（GOV O8）：90 天在线、超窗转 gz——接受？
7. **spend 台账精度**（GOV O10）：无自动对账、靠人工补录——够用？
8. **笔记强制力**（MEM 开放 4）：维持"提醒一轮+记 missed"软线，还是硬到"完成前必须有记忆动作"？
9. **sealed+365 天自动删历史**（MEM 开放 5）：接受？还是只封存永不删？
10. **CLI 命名**（MEM 开放 8）：维持 `dotd notes/history` 两域，还是单一 `dotd memory`（需与治理联动改名）？
11. **headed + Xvfb vs headless**（EX Q2）：stealth 更强 +~50MB 常驻；MVP 内存优先可切 headless。
12. **时区**（CP 开放 6）：cron/quiet_hours 默认 Asia/Shanghai——确认。
13. **看门狗超时数值与机制**（CP 开放 4 + 本文 R5 已定公式口径与输入数值）：过渡值 `1_860_000ms` 可直接动工（不阻塞 D2，D2 起即用配置项实现）；主人只需定夺是否改用"步内续跳"把值缩回 90–120s（属小幅新增设计，见 R5 缓解列）。
14. **deadline 上限与审批超时对齐**（EX Q5：现 30min vs TTL 24h 的"浏览器等待登录"场景）。
15. **docker.sock 最小权限代理**（EX Q1）：MVP 用 docker 组全权，阶段三是否做代理？
16. **首次人工登录通道**（本次读者意见 F1 新增；六份模块文档+契约均未设计，§5"阶段一身份链路"小节列出三条候选）：接受 (a) profile 卷预置（零新接口，纯运维复制宿主 Chrome profile 进 `dot1-profiles` 卷）？还是赌 (b) WSLg/X11 显示转发（先做 C10 实测）？(c) agent 登录流涉新审批设计、MVP 不推荐。**此项不定，锚① 只能按退化条款执行**。
17. **身份登记的对外入口形态**（F1 连带，倾向由主人一并背书即可）：登记接口本身已定（EX `setIdentityProfile`），但主人日常改身份/加身份走 CLI（`dotd identity add` 之类）还是 Web 页——SF §5.2 路由表现无此端点，属机械扩展；阶段一最小实现 = daemon 引导脚本内调用 + CLI 一条命令，Web 页推阶段二。

**C. 施工期实测/标定项（答案来自环境，不需主人预先决策）**

1. WSL2 docker pause 实测（CP #1 / R2）——D1。
2. setuid(1001) state 卷方案实测（EX Q7 / R1）——D1。
3. netfuzz 确位 + 水位首启标定（CP #3 / R3）。
4. OLMoE 有无任何工具调用能力实测（MR 开放 1；锁 light 轨现状不动，实测加行即放开）。
5. 本机 SMTP 出口可达性真实发送测试（MR 开放 3，阶段二前）。
6. quota 型 429 文案识别正则集（MR 开放 4，实现期建）。
7. dockerd CPU 落组观测（EX Q4，boot 记录实际核数）。
8. MAX_CONTEXTS=2 双站并开基准回填 limits_json（EX Q6）。
9. `chat.delta` 默认开关与 TG debounce 3s 实测（SF Q5/Q6）。
10. **WSLg/X11 显示转发可行性**（本文 B16 候选通道 b：Win10 19045 + WSL 内核能否把容器内 `Xvfb :99` 的 chromium 窗口显示到宿主；D5 前实测，失败即 B16 只剩通道 a）。
11. **看门狗过渡值的在途调用盲区标定**（本文 B13/D2 注记：`beginTool→endTool` 之间无 heartbeat 写点，需实测单步最长在途时长分布，校准过渡值或引入心跳续跳）。

**D. 结构/接口矛盾标注（本次合并审读发现，模块文档原文未察觉）**

1. **TTL(24h) × run_at × maxRunning=1 的饿死窗口**（本文 §8.1②与 GOV pending_until 联合推演）：pop 谓词定稿后（§2 决策 3），到期任务（`run_at<=now`）与即时任务同池按 `priority ASC, COALESCE(run_at,created_at) ASC` 竞争——若"主人手动任务 priority=1 永不淘汰"与"到期定时任务同 queued 排队"同时成立，一条高优先对话任务的排队可饿死到期心跳定时（如每日晨报在 24h TTL 审批单等待主人期间持续被更高优先任务插队、过期后建的新单又持续排队），心跳静默失效。契约 E2/J6/CP §4.1/§4.4 均无仲裁。建议修复：pop 排序对 `run_at` 已到期 > N 小时的老化 boost，或 heartbeat 到期投递直送 pop 顶位——实施期（D13）实测暴露前定夺。
2. **GOV 磁盘稿与契约 G1 的登录态谓词冲突仍在文件里**：本方案第 4 章与 §9.2 已按契约口径（顶层 identity）书写；GOV §2.2/§2.4/S2 的 identityParam 表述未回改（待改清单#GOV 第一条）。动工以本文为准，GOV 原文仅作历史参考。
3. **CP 磁盘稿 §4.3/S6"心跳归 surfaces、CP 不自建 crontabs"与契约 H1"crontabs 归 CP 单表"方向相反**：本文按契约（H1 胜）。CP 原文引用 heartbeat_target 的段落均作废。
4. **MR §6.2"waiting_model"字样与 CP `paused(circuit_open)`**：契约 T1 已裁，本文全部用后者；MR 原文仅 §4.2 尾注残留旧词。
5. **契约 J4"重活经 submit 入队、track=light"缺 task→调用点打标载体**（本次读者意见 F5 核对时发现，契约自身留白）：E2 的 submit 签名无 track 参数、tasks 表无 track 列，契约也未裁"Runner 如何知道该任务的 LLM 调用走 light 轨"。本文 §2"track 的定界"给出与 MEM/MR/J4 三份原文最兼容的实施读法（payloadJson=CompactionJobSpec → light + 60s），并在此如实登记：若主人/仲裁方另有意图（如新增 tasks.track 列），以仲裁为准——**动工 D12/D13 前建议在契约 §10 待改清单补一条裁定**。
6. **契约 :35"dot 主档（配额、身份表等）列入阶段三设计项"与 EX 阶段一交付 `exec_identities`+`setIdentityProfile` 的措辞撞车**（本次读者意见 F1）：契约 §10 待改清单与 EX 修订均未作废该表、验收锚与 D8/D13 依赖登录态身份行。本文 §1.4 注已按范围界定处理（阶段三= `dots` 主档表与跨 Dot 身份路由；阶段一= 单 Dot 身份登记）。此为对契约 :35 的解释性收窄，**若主人不认可该界定，锚① 的阶段一范围需同步收缩**——登记于此供仲裁复核。

### 11.3 验收锚点（MVP 完成定义）

1. §8 走查 12 段用真实 webhook 跑通一次浏览器任务；其中"含登录态审批"段以 §5"阶段一身份链路"小节完成过一次真实首登（B16 通道 a 或 b）为准；两通道均不可用时按该节退化条款执行（`identity:'anon'` 非登录态浏览器任务 + 合成登录态 ToolCall 恒 approve 单测），验收记录如实注明；
2. §8.2 崩溃表 13 格逐格 `kill -9` 演练无重复执行、无双建任务、审批不丢；
3. **mode 链演练（本次读者意见 F2 的判定口径定稿）**：拔主通道网线 → mode 链 NORMAL→LOCAL_FALLBACK→（本地 busy 三连入窗、tier2 熔断）→ 再降级/终档 自动复现，OUTBOX 恰好一条 HELP（24h 内不再发）。**默认语义按 B1 未批准的现设计判定**（MR §4.3:525 + 契约 T1）：① **light 轨真实在本地跑通**（event.match/摘要等落 tier2——models.yml tier2 默认即有 `models.light`，MR:71，不受 B1 影响）；② **primary 任务不入本地**——route 耗尽后任务达 `paused(stop_reason='circuit_open')`（不是"本地跑主循环"）；③ mode 恢复（插回网线、半开 closed）后 paused(circuit_open) 任务自动回 queued 续跑。**若主人批准 B1**（models.yml tier2 显式写 `models.primary`）才追加变体判定④：primary 由 7B 承载、`RouteMeta.degraded=true` 落 `model_call_log.degraded` 且审查加验生效——该变体不是默认验收线。
4. 全链路磁盘 du 基线 < 既定预算（镜像 2 tag + 三卷 + db<500MB + 归档<200MB）；
5. 主人日用：`dotd ask` 一句话→卡片审批→结果回话，无一次手工重启 daemon。

---

*编定于 2026-10-14；同日按独立读者五条动工阻塞意见（F1 身份登记与首登链路、F2 降级验收口径、F3 看门狗数值、F4 pop 谓词、F5 接口参数表）修订为 rev-b：§1.4 注、§2 决策 3 与接口定稿表、§5 身份链路小节、走查④⑥、§8 范围注、D2/D5/D8/D13、R5、B13/B16/B17、C10/C11、D5/D6、锚①③。*源文件行号均指磁盘 rev2 版本；接缝契约 §10"待改清单"是各模块文档的后续修订工单，动工时以本文与契约为准、按清单逐行回改原文。*
