# 模块详设：控制面与任务队列（control-plane）

> 契约来源：`dotd-design/CONTEXT.md`（下称 CT）。本文只改本模块文件；与其他模块的冲突以"接缝假设"（§9）声明交仲裁，本文不擅改他模块文档。
> 技术选型锁定（CT:18）：TypeScript 单进程 daemon（Node 24）+ SQLite；daemon 跑 WSL Ubuntu-24.04 内（CT:34）；不得推翻。
> **修订说明**：本版为评审返工稿，逐条响应见文末「§13 评审响应」。凡与旧稿矛盾处，以本版为准。

---

## 1. 模块职责与边界

### 1.1 职责（本模块拥有）

| # | 职责 | 说明 |
|---|---|---|
| R1 | 进程模型 | 单进程 daemon 内部组织：event loop、scheduler tick、timer、子进程边界、优雅关停、**Runner 协程 abort** |
| R2 | 任务队列 | SQLite 持久化队列：优先级、到期扫描、领取（pop）、**epoch 围栏**、心跳超时看门狗、重试 |
| R3 | 步骤级 journal | 逐步骤落盘 + **call_id 幂等对账**：崩溃后已落盘结果绝不重放、未知副作用绝不自动重执行（CT:44） |
| R4 | 事件→目标匹配 | 消费 surfaces 的 `event_log` 行，经规则+低智能模型分类 `run_new/merge/ignore`，带置信度与理由（CT:45） |
| R5 | 重启恢复 | serve 重启不丢队列（CT:45）：在途任务经 epoch 围栏回可继续态、journal 归置、错过的定时按 surfaces 心跳 catchup 语义处理 |
| R6 | 资源上限与背压 | 与 netfuzz 共存（CT:35）：内存水位四级背压（**自动基线标定**）、容器配额、DB/journal 磁盘回收（CT:37） |
| R7 | 统一调度器 | 本模块的 scheduler 是**全系统唯一周期任务宿主**：治理 `expirePending/compactAudit`、模型路由 janitor、心跳调度、§6.5 GC 均经 `registerInternalJob` 挂到这里（governance.md:624、model-router.md:373） |

### 1.2 边界（本模块不拥有，只消费/被消费）

- **不拥有** `event_log / approval / approval_response / heartbeat_target / jsonl_offset` 表——字段属主是 surfaces（surfaces.md:70）。本模块只读 `event_log` 行做匹配、把匹配决策写进**自有表 `event_decisions`**；心跳到期的"何时触发"由 surfaces 定义、由本模块 scheduler 代跑（§4.3）。
- **不拥有** 审批状态机与 `approvals` 表——属治理（governance.md:432）。本模块只引用治理的 `approvals.id`，并只暴露"任务卡在 `awaiting_approval`"这一队列态；副作用未知→强制转审批经治理 `requestApproval` 落地。
- **不拥有** `mem_threads / mem_messages`（记忆）、容器创建与 profile 卷（执行面）、`model_*`（模型路由）、`audit_log`（治理）。
- **不实现** LLM↔工具主循环（Dot Runner）；本模块是它下面的队列+journal+调度+背压地基。

### 1.3 库文件、迁移与归属（对旧稿"三处冲突"的收敛）

- **单库文件**：`~/.dotd/dotd.db`（WAL）。采信 surfaces.md:57 / memory.md:44 两处一致的选择；**不采信** governance.md:426 的 `control.db` 命名（接缝 S12 提请统一，见 §9）。本模块所有连接指向同一路径。
- **迁移版本机制**：`PRAGMA user_version`，由**控制面 db 模块统一管理**（governance.md:429 明文"归控制面 db 模块统一管理"）。本模块的建表脚本即 schema.sql，版本随 user_version 递增。
- **表前缀**：memory.md:376 建议 `queue_/gov_/exec_`；governance.md:429 说前缀"不强制"，surfaces.md 全程无前缀。本模块**沿用无 `mem_` 冲突的直白名**（`tasks/steps/event_decisions/resource_events`），但铁律改为 memory.md:376 的实质约束：**不建跨模块所有权的 FOREIGN KEY**，一律弱引用（列存在即可，不约束）。旧稿中 `tasks.source_event_id REFERENCES events(id)`、`steps… REFERENCES tasks` 的跨/同属主外键按此调整（同属主保留，跨属主去掉）。

**本模块拥有 DDL 与读写权**：`tasks`、`steps`、`event_decisions`、`resource_events`。其余（`approvals/audit_log`=治理、`mem_*=记忆`、`model_*=路由`、`event_log/heartbeat_target/approval/jsonl_offset`=surfaces、`exec_calls`=执行面）只读或经对方 API 写入。

---

## 2. 进程模型（R1）

### 2.1 拓扑：一个 OS 进程，零 worker，Runner 是协程

```
dotd-daemon (Node 24, 单进程)
├─ scheduler loop     setInterval 1s：①跑 surfaces.heartbeat_target 到期判定并投 event_log ②pop 队首交 Runner
│                     ③看门狗(10s 子周期) ④memory guard(5s 子周期) ⑤所有 registerInternalJob（治理/路由 cron）
├─ event loop         全系统唯一；SQLite 同步写走它，写 journal 微秒级，无跨进程锁
├─ Agent Runner ×N(≤maxRunning)  同进程 async 协程（LLM↔工具），await 式，非子进程
├─ HTTP server        :127.0.0.1:8642  内部 API + 事件 webhook（Web UI 经端口转发，CT:34）
├─ 唯一的 child_process  docker stats / docker pause·unpause·kill（经 WSL docker.sock，非 dotd 计算）
└─ 优雅关停 / abort 通道  向 Runner 协程传 AbortSignal（不是 SIGSTOP——协程无法被信号停）
```

关键决策与理由：

1. **不用 cluster/worker_threads**：并发上限是模型 API 与容器，非 CPU；单 event loop 天然消灭并发写者，journal 一致性只靠进程内顺序。CLI 阶段一只经 HTTP API，不直连库（避免第二写者）。
2. **SQLite 参数**：`journal_mode=WAL; synchronous=FULL; busy_timeout=5000;`。`synchronous` 是**每连接**属性：本模块用 FULL（断电不丢 journal 已提交步，R3 优先），记忆模块自连用 NORMAL（memory.md:261）——互不影响；`journal_mode` 是库级持久属性，两边一致。
3. **CPU/内存亲和**：CT:33 的 processor-group 教训适用于 Windows 原生进程；daemon 在 WSL2（轻量 VM）内，Windows 侧由 `vmwp` 调度，本模块控不到 group。落地：`.wslconfig` 设 `memory=` **32GB**（详见 §6.3 重标定，旧稿 24GB 与 netfuzz 20GB 常驻矛盾）与 `processors=24`，dotd 自身 `--max-old-space-size` 由 surfaces.md:55 已定 1024MB。
4. **优雅关停**：SIGTERM/SIGINT → ①停 pop 与心跳投递 ②向**在跑 Runner 协程传 `AbortSignal`**，Runner 在**当前步骤边界**落 journal 后自然退出，上限 `shutdownGraceMs=30s` ③超时不 SIGSTOP（协程模型里无此原语，旧稿 §2.1-4 的"docker exec 被 SIGSTOP"仅指那唯一子进程；对 Runner 一律 AbortSignal），直接 `process.exit()`，由 §7 恢复兜底。

### 2.2 并发额度与 epoch 围栏（对"双 Runner 互相破坏"的根治）

- MVP（CT:51）`maxRunningTasks=1`；配置化，阶段三按 dotId 分桶。
- **每次把任务从可领态转入 `running`，`tasks.run_epoch += 1`**，pop 返回的 Task 快照带此 epoch。Runner 持有该 epoch，其所有回写（`heartbeat/endTool/finish/bindSession`）必带 `epoch`；本模块每条 UPDATE 都 `WHERE task_id=? AND run_epoch=?`，**受影响行数 0 → 判为"迟到/僵尸 Runner"，写 `resource_events(kind='stale_writer')` 并拒绝**。这条围栏使得：看门狗/背压 abort 后旧协程即便稍后 `endTool` 也无法把已被 `resolveOpenStep` 改过的行改回——旧写入被拒（issue #2 的核心修复）。

### 2.3 同进程低延迟

`submit`/`ingestEvent` 成功后 `setImmediate(() => scheduler.wake())`，不等 1s tick。

---

## 3. 数据结构与表设计

TS 类型（`src/control-plane/types.ts`）：

```ts
export type TaskStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'paused'
  | 'done' | 'failed' | 'cancelled';

export type StepStatus = 'pending' | 'started' | 'succeeded' | 'failed' | 'interrupted' | 'skipped';
//                     待审批           执行中(崩溃孤儿=started)     完成        失败       被打断   审批被拒/过期跳过
export type StepKind   = 'llm' | 'tool';
export type SideEffect = 'safe' | 'replayable' | 'unknown';   // 执行面工具注册表提供（CT:44）

export interface Task {
  id: string; dotId: string; title: string; goal: string;
  status: TaskStatus; priority: number;
  runAt: number | null;
  sourceEventLogId: number | null;   // surfaces.event_log.id（弱引用，无外键，§1.3）
  sessionId: string | null; threadId: string | null;   // 记忆模块（§8 bindSession 回写）
  attempt: number; maxAttempts: number;
  runEpoch: number;                  // 围栏：每次转 running +1（§2.2）
  lastHeartbeatAt: number | null;
  budgetTokens: number; usageTokens: number;
  resumeFromSeq: number | null;      // 审批放行后从哪一步续（§4.1）
  stopReason: 'user'|'tool_risk'|'circuit_open'|'watermark'|'budget'|'shutdown'|null;
  createdAt: number; updatedAt: number;
}

export interface Step {
  taskId: string; seq: number;
  kind: StepKind; status: StepStatus;
  callId: string | null;             // 工具步：ULID，journal.beginTool 生成，==治理 ToolCall.callId==exec call_id（§5.5）
  toolName: string | null;
  argsJson: string | null; resultJson: string | null;
  sideEffect: SideEffect | null;
  runEpoch: number;                  // 写该步时的任务 epoch（与围栏联动，审计可辨哪代 Runner 写的）
  approvalId: number | null;         // 若因审批挂起：治理 approvals.id（弱引用）
  startedAt: number; finishedAt: number | null;
}

// 事件匹配决策（本模块自有，键=surfaces.event_log.id，天然幂等）
export interface EventDecision {
  eventLogId: number;
  action: 'run_new' | 'merge' | 'ignore';
  taskId: string | null;
  confidence: number;
  reason: string;
  via: 'rule' | 'llm' | 'manual';
  decidedAt: number;
}
```

### 3.1 全量 DDL（本模块拥有）

```sql
-- 3.1.1 任务队列 -----------------------------------------------------------
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,                 -- 'tk_'+base36 时间序 + rand
  dot_id        TEXT NOT NULL DEFAULT 'dot1',
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('queued','running','awaiting_approval','paused','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 5,
  run_at        INTEGER,
  source_event_log_id INTEGER,                    -- 弱引用 surfaces.event_log.id，无外键（§1.3）
  session_id    TEXT,                             -- 弱引用记忆 mem_sessions（§8 bindSession）
  thread_id     TEXT,                             -- 弱引用记忆 mem_threads（memory.md:178 约定 tasks 携此列）
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_epoch     INTEGER NOT NULL DEFAULT 0,       -- 围栏，转 running 时 +1（§2.2）
  last_heartbeat_at INTEGER,
  resume_from_seq   INTEGER,                      -- 审批放行后从第 N 步续跑（§4.1）
  stop_reason   TEXT CHECK (stop_reason IN
                  ('user','tool_risk','circuit_open','watermark','budget','shutdown') OR stop_reason IS NULL),
  budget_tokens INTEGER NOT NULL DEFAULT 200000,
  usage_tokens  INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,     -- 超限置位，heartbeat 返回给 Runner 促其收尾（§6.4）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_pop  ON tasks(dot_id, status, priority, run_at);
CREATE INDEX idx_tasks_live ON tasks(dot_id, status)
  WHERE status IN ('running','awaiting_approval','paused');
CREATE INDEX idx_tasks_done ON tasks(status, updated_at)
  WHERE status IN ('done','failed','cancelled');

CREATE TABLE task_results (
  task_id  TEXT PRIMARY KEY REFERENCES tasks(id),   -- 同属主，FK 允许
  summary  TEXT NOT NULL,
  ok       INTEGER NOT NULL
);

-- 3.1.2 步骤级 journal -----------------------------------------------------
CREATE TABLE steps (
  task_id     TEXT NOT NULL,                       -- 同属主，应用层约束，不建 FK 以免 VACUUM/reorder 摩擦
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('llm','tool')),
  status      TEXT NOT NULL CHECK (status IN
                 ('pending','started','succeeded','failed','interrupted','skipped')),
  call_id     TEXT,                                -- 工具步幂等键；UNIQUE 见下
  tool_name   TEXT,
  args_json   TEXT,
  result_json TEXT,
  side_effect TEXT CHECK (side_effect IN ('safe','replayable','unknown')),
  run_epoch   INTEGER NOT NULL,
  approval_id INTEGER,                             -- 弱引用治理 approvals.id（pending 步才有）
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (task_id, seq)
);
CREATE UNIQUE INDEX uq_steps_call ON steps(call_id) WHERE call_id IS NOT NULL;  -- 供 exec/governance JOIN
CREATE INDEX idx_steps_open  ON steps(task_id, status) WHERE status IN ('started','pending');

-- 3.1.3 事件匹配决策（本模块自有；事件本体在 surfaces.event_log，不重复建表）----
CREATE TABLE event_decisions (
  event_log_id INTEGER PRIMARY KEY,               -- == surfaces.event_log.id，天然幂等
  action       TEXT NOT NULL CHECK (action IN ('run_new','merge','ignore')),
  task_id      TEXT,                               -- run_new=新建，merge=目标已有；ignore=NULL
  confidence   REAL NOT NULL,
  reason       TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('rule','llm','manual')),
  decided_at   INTEGER NOT NULL
);

-- 3.1.4 背压 / 围栏 / 资源事件日志 ------------------------------------------
CREATE TABLE resource_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('normal','guarded','throttled','halted')),
  kind   TEXT NOT NULL CHECK (kind IN
           ('watermark','container_pause','container_unpause','container_kill',
            'queue_evict','disk_gc','stale_writer','watchdog','budget')),
  detail TEXT NOT NULL
);
```

磁盘上限（CT:37）：`dotd.db` 软上限 500MB（`VACUUM` 兜底，§6.5）。`steps.args_json/result_json` 单值截断 32KB，超出落 `journal-blobs/<task_id>.<seq>.json`（≤500MB）。`event_decisions` 随 `event_log` purge 由 surfaces 主导、本模块按 event_log.id 级联清理（§6.5）。

---

## 4. 任务队列：优先级 / 定时 / 心跳 / epoch

### 4.1 状态机（tasks.status）

```
 submit / ingestEvent(run_new)
        │   pop（唯一入 running 的通道，受 maxRunning + 背压门控）
        ▼        ▲
     queued ─────┴──▶ running ──①治理 requestApproval→──▶ awaiting_approval
        ▲  ▲            │  ▲                                  │ 审批落定(ok|deny)
        │  │            │  │ AbortSignal(watchdog/guard/user)  │ onApprovalSettled：
   budget/ │      finish│  └──resolveOpenStep+epoch──┐          ▼
   circuit │       (ok) │                            │      ok → queued(resume_from_seq=该步)  ← 回 queued，非直入 running
   watermark  ─────▶ done                            │      deny/expired → running(skipped 步)后继续 或 queued
        │      finish(err,attempt<max)→ queued(attempt+1,run_at=now+backoff)
        │      finish(err,attempt≥max)→ failed
   paused(手动/水位 halt) ──水位回 guarded/normal──▶ queued（批量，保 priority）
```

**三条硬门控**（issue #5 修复）：

1. **进 running 只经 `pop()`**，`pop` 内强制 `背压∈{normal,guarded}` 且 `runningCount(dot)<maxRunningTasks` 且 `run_epoch+=1`。因此 `awaiting_approval →(ok)→ queued`（**不是直转 running**）：审批放行后任务重新排入队首（`priority=min(priority,2)`，记 `resume_from_seq`），等 pop 拿围栏。这样 `maxRunningTasks=1` 时**不可能出现两个并发 Runner**——旧稿 `onApprovalSettled` 直接 ok→running 绕过门控的漏洞被消除。
2. `paused / awaiting_approval` 是可再入态，不占 `runningCount`。
3. `resolveOpenStep` 只处理 `status='started'` 的**孤儿**步；`status='pending'`（待审批）的步**不算孤儿**——数据上 `started`=执行中被打断，`pending`=正常等待，可区分（issue #5a：不再把等审批的步误标 interrupted）。

非法转移在 `transition()` 硬校验，throw。看门狗（§2.2、§7.4）：10s 扫 `status='running' AND now-last_heartbeat_at > HEARTBEAT_TIMEOUT_MS` → 对旧 Runner 协程 `abort()` → `resolveOpenStep`（epoch 围栏使旧协程迟到写回被拒）→ 回 `queued`、`attempt+1`、`run_epoch` 已在下次 pop 时递增。

### 4.2 pop（单写者事务 + 围栏递增）

```ts
const pop = db.transaction((dotId: string, now: number): Task | null => {
  if (guard.level === 'throttled' || guard.level === 'halted') return null;
  if (runningCount(dotId) >= cfg.maxRunningTasks) return null;
  const row = db.prepare(`
    SELECT * FROM tasks
    WHERE dot_id=? AND status='queued' AND (run_at IS NULL OR run_at<=?)
    ORDER BY priority ASC, COALESCE(run_at, created_at) ASC, resume_from_seq IS NOT NULL DESC
    LIMIT 1`).get(dotId, now);
  if (!row) return null;
  // resume_from_seq IS NOT NULL DESC：审批放行的续跑任务优先于新任务，减少 LLM 重复预算
  db.prepare(`UPDATE tasks SET status='running', run_epoch=run_epoch+1,
              last_heartbeat_at=?, updated_at=? WHERE id=? AND status='queued'`)
    .run(now, now, row.id);
  return getById(row.id);          // 含新 run_epoch，交 Runner 当围栏凭据
});
```

`BEGIN IMMEDIATE`（better-sqlite3 默认）使未来任何第二个写进程（如误配的独立 CLI）与 pop 串行化。

### 4.3 心跳与定时（统一走 surfaces.heartbeat_target + 本模块 scheduler；issue #10）

**仲裁立场**：`heartbeat_target` 表与"何时到期/是否跳过/补跑语义"的字段属主是 surfaces（surfaces.md:183）。本模块**不再自建 `crontabs` 表**（旧稿 §3.1.4 的 crontabs 删除）。分工：

- **判定循环**由本模块 scheduler 代跑（governance.md:624 "控制面统一调度器/心跳调度器同源"；model-router.md:373 janitor 也挂这）：每 tick `SELECT * FROM heartbeat_target WHERE enabled=1 AND next_due_at<=now`。
- 到期后**尊重 surfaces 定义的语义**触发：`quiet_hours` 内跳过、`skip_if_busy=1` 且同 dot 有 live 任务则跳过（写 `last_fire_status='skipped_busy'`）。
- **补跑语义采信 surfaces 而非旧稿**：`catchup='latest'` → 错过 k 次只投 **1 次**最新（goal 附"停机期间错过 k 次"），`catchup='skip'` → 不补、直接推进 next_due_at。旧稿"合并 1 次且 k>5 丢弃"作废（与 surfaces 冲突且更复杂，采纳 surfaces 两态）。
- 触发 = **向 surfaces 的 `submitEnvelope()` 投一条 heartbeat 事件**（source='heartbeat'，dedup_key `hb:<name>:<fire_seq>`，fire_seq 自增防重，surfaces.md:141），落 `event_log`；本模块匹配层据 heartbeat 规则→run_new 建任务。心跳与外部事件同路（CT:17）。
- `last_fire_seq/last_fired_at/next_due_at` 由本模块 scheduler 回写（surfaces.md:198 声明这些"调度器维护"）。
- **系统自检心跳**（如 `*/10 * * * *` 健康检查）作为一条 `heartbeat_target`（`enabled` 内部项），非用户任务，与本模块无特殊耦合。

### 4.4 队列上限与淘汰（issue #15）

`cfg.maxQueued=200`。淘汰只在 **`submit`/匹配产出 `run_new` 时、且当前 queued 数已达上限**触发：

```
候选 = 已存在的 status='queued' 且 source_event_log_id 非空(自动生成) 的任务，按 (priority DESC, created_at ASC) 排序；
     主人手动提交(goal 无 source_event_log 或 via='manual')的任务永不入候选。
先试 merge：把新事件并入一个 priority 相近、同 dot、status∈{queued,running,paused} 的既有任务
     （§6.2 合法目标集；running 任务的 merge 走 note 注记，paused 走 goal 追加）。
merge 成功 → 不新建、不淘汰，写 decision(action='merge')。
merge 失败（无同目标）且 queued 已满 → 淘汰候选队首（最旧最低优先自动任务）→ cancelled(stop_reason='user'否，
     新枚举 stop_reason 不含 evict，记 status='cancelled' + resource_events(kind='queue_evict', detail=taskId)）；
     腾位后再建新任务。
```

旧稿把淘汰记成 `disk_gc` 是语义污染；新枚举已加 `queue_evict`（§3.1.4）。§6.2 merge 目标集与"可 merge 对象"的关系在此固化：merge 只针对**既有非终态任务**，被淘汰的是**另一批既有自动任务**，两者不重叠（incoming 是尚未落库的新事件，谈不上 merge 自身）。

---

## 5. 步骤级 journal：崩溃安全 + call_id 幂等对账（R3）

### 5.1 副作用三分类（契约点，执行面提供）

| 类别 | 例 | started 孤儿处置（无 exec 佐证时） |
|---|---|---|
| `safe` | 读文件、只读 shell、页面 snapshot/screenshot、navigate | 重放 |
| `replayable` | 覆盖写文件、fill、纯函数 evaluate | 重放 |
| `unknown` | click 提交、发消息、写/网络副作用 shell、不可逆 | **先对账**再决定，绝不盲目重放 |

### 5.2 写入时序（两步落盘；call_id 先写后调；issue #6 补齐 call_sent/call_done）

journal 是**唯一**写 steps 表的路径；`beginTool` 生成的 `call_id` 同时是对账/审批/执行三方的步身份（§5.5）。

```ts
journal.beginTool(taskId, epoch, toolName, args, sideEffect): { seq, callId }
//  事务内：seq=max+1；callId=ULID()；
//  INSERT steps(task_id,seq,kind='tool',status='started',call_id,tool_name,args_json,side_effect,run_epoch,started_at)
//  —— synchronous=FULL，行提交先于任何外部调用。这就是"call_sent"记录（对齐 execution.md:247/462）。
const res = await exec.runTool({ callId, taskId, tool, args });   // 执行面按 callId 幂等（至多一次）
journal.endTool(taskId, epoch, seq, ok?'succeeded':'failed', result);
//  UPDATE ... SET status, result_json, finished_at WHERE task_id=? AND seq=? AND run_epoch=?
//  —— 行数 0 → 迟到 Runner，拒绝并记 stale_writer（§2.2 围栏）。"succeeded 落库"即 call_done。
```

- 若需审批（治理在 `runTool` 前 `evaluate→approve`）：本模块把该步转 `status='pending'`、写 `approval_id`，任务 `running→awaiting_approval`（§4.1）。**pending 步是"等待"，不是"崩溃孤儿"**，恢复扫描只认 started（issue #5a）。
- LLM 步（无外部副作用，只有钱）：`beginLlm(epoch, promptDigest)→seq`（INSERT started，存 prompt hash 不存全文，体积）；`endLlm(...,respDigest)`（UPDATE，结果截断）。started 孤儿→标 interrupted、不重放（省钱）。**LLM 全量文本的恢复责任在记忆模块**（§7.3、接缝 S5），journal 只存 digest。

### 5.3 恢复语义（"绝不重复执行"的实现；unknown 前先对账）

对每条孤儿 `started` 步，**daemon 重启（§7.1）、Runner abort 后重领（§7.4）**都走同一函数：

```ts
function resolveOpenStep(taskId, epoch, seq): 'replayed' | 'deferred' | 'took_result' {
  const s = getStep(taskId, seq);
  if (s.kind === 'llm') { markInterrupted(taskId, seq); return 'replayed'; }   // 不重放 LLM，从自然下一步续

  if (s.side_effect === 'safe' || s.side_effect === 'replayable') {
    markInterrupted(taskId, seq);
    return 'replayed';                    // Runner 重放：重读页面/文件再决策
  }

  // unknown：先向执行面对账该 call_id 的真实结局（issue #6）
  const outcome = await exec.reconcileCall(s.callId);   // 'done'|'aborted'|'unknown'|'unknown_host'
  if (outcome === 'done') {                              // 副作用其实已完成，只是没落库
    const r = await exec.getCallResult(s.callId);        // 取 result_hash/value（execution.md:242 ledger）
    finalizeStepAsSucceeded(taskId, seq, r);             // 补记，不重放
    return 'took_result';
  }
  if (outcome === 'aborted') {                           // 工具体未跑或已回滚 → 按 replayable 安全重放
    markInterrupted(taskId, seq); injectRecoveryNote(...); return 'replayed';
  }
  // outcome unknown / unknown_host：无法判定，宁可让 agent 重观测
  markInterrupted(taskId, seq);
  injectRecoveryNote(taskId, seq, s);
  if (cfg.treatUnknownAsRisk)                            // 默认 true；应急模式强制 true（CT:29）
    governance.requestApproval(taskId, { journalStep: s.callId, kind: 'side_effect_unknown',
                                         tool: s.toolName, params: s.argsJson, ... });  // 落治理 approvals，返回 approval_id
  return 'deferred';
}
```

三条硬保证（补强）：

1. **已 succeeded 步永不重执行**：恢复从 succeeded 步直接取 `result_json` 注入上下文。
2. **unknown 步先对账再决策**：执行面确认 `done` 则补记结果（不重放也不白花），确认 `aborted` 才重放，仍未知才"注入未知提示 + 转审批"。这比旧稿"一律不重放"更省预算，同时守住"绝不重复执行"——因为 `done` 分支不执行、`aborted` 分支执行面保证未落地。
3. **审计闭环**：孤儿步转 interrupted（不删），治理 `uniq_open_step`（governance.md:456）以 `journal_step=call_id` 保证同一步至多一张活动审批单——本模块 `resolveOpenStep` 重试调 `requestApproval` 同一 callId 会命中同一单（幂等）。

`injectRecoveryNote` = 下一步 messages 首条注入："你上一步 {tool}({args摘要}, callId={callId}) 因中断结果未知，先做观测确认再决定；不可确认且不可逆则已转审批。"

### 5.4 journal 大小控制

args/result >32KB 截断存 `"@blob:journal-blobs/tk_x.N.json"`。单任务步数软上限 500（warning）、硬上限 2000 → `failed(stop_reason='budget')`（旧稿硬上限是步数，token 预算另见 §6.4，两者不混淆——issue #14 澄清）。

### 5.5 call_id = 三方统一的步身份（issue #11 收口）

- **对外/跨模块的步引用一律用 `call_id`（TEXT ULID）**：治理 `approvals.journal_step`（governance.md:438）、执行面 `exec_calls.call_id`（execution.md:400）、`audit_log.journal_step` 都以此为键。
- `(task_id, seq)` 是本模块内部排序主键，不外泄为审批引用。surfaces.md:149 的 `approval.step_id INTEGER` 与本契约不符——记入接缝 S11 提请 surfaces 改为 `journal_step TEXT=call_id`（本模块不动 surfaces 文件）。
- 本模块暴露 `journal.getStepByCallId(callId)` 供治理/执行面反查；旧稿审计"引用 (task_id,seq)"改述为"引用 (task_id, seq, call_id)，外部键取 call_id"。

---

## 6. 事件→目标匹配（R4）与资源上限（R6）

### 6.1 匹配管线（消费 surfaces.event_log，写自有 event_decisions；issue #1/#9）

```
入口(surfaces.submitEnvelope) → 落 event_log(surfaces 负责 dedup_key 与幂等、NULL dedup 不去重)
   → 本模块 scheduler.wake 扫 event_log 中「未被决策」的行：
        谓词：NOT EXISTS(SELECT 1 FROM event_decisions d WHERE d.event_log_id=e.id)
             AND e.status IN ('pending','enqueued')
        逐行（按 received_at 升序）跑匹配，产出一条 event_decisions + （run_new 时）建任务。
```

**幂等核心修复（issue #1，旧稿"dedup_key 保证不重复建任务"是错的——那是 surfaces 的事件行去重，防不了本模块重复建 task）**：

> **"建任务 + 写 event_decisions" 必须在同一个 `BEGIN IMMEDIATE` 事务里。**

```ts
const decideAndCreate = db.transaction((e: EventLogRow, m: Match) => {
  if (exists(event_decisions, e.id)) return;          // 双保险：已决策直接跳过（重启 replay 命中此路）
  let taskId = null;
  if (m.action === 'run_new') {
    taskId = deterministicTaskId(e.id);               // 主键 = 'tk_ev_'+e.id，事件↔任务确定性映射
    insertTask({ id: taskId, source_event_log_id: e.id, ... });
  } else if (m.action === 'merge') { insertNote(...); taskId = m.targetTaskId; }
  insert(event_decisions, { event_log_id: e.id, action: m.action, task_id: taskId, ... });
  update event_log.status='enqueued' WHERE id=e.id;   // surfaces 字段的"消费标记"
});
```

- `deterministicTaskId(e.id)`：task 主键直接由 `event_log.id` 派生（`'tk_ev_'+id`），崩溃重放到同一 event 行 → 主键撞 `tasks.id` PK → 事务回滚，绝不会产生第二个任务。这把旧稿"task_id=时间序、与事件无映射"的洞彻底堵死。
- 重启时 `replayUndecidedEvents()`（§7.1 步骤 6）只是重跑这个幂等事务；已建任务的事件已有 event_decisions 行，`exists` 短路。
- 规则层（source='heartbeat'、启动 ruleSet event-rules.yml）零成本可解释，via='rule',confidence=1.0。模型层 via='llm' 调 `ModelRouter.completeLow`，严格 JSON 解析一次。落 inbox（surfaces/治理展示，via 待 manual）。

### 6.2 置信度分档与 merge 语义

| confidence | 动作 |
|---|---|
| 规则命中 | 恒 1.0 |
| ≥ 0.85 | 直接执行 decision |
| 0.55–0.85 | 执行 + 推通知"已自动处理，理由：{reason}，可撤销"；撤销=任务 cancelled + event_decisions 行删除（事件回未决策，可重匹配） |
| < 0.55 | 不建/不并，写 event_decisions(action='ignore',confidence) 但 surfaces 收件箱高亮，等主人一键 `retryMatch`（via='manual' UPSERT 覆盖旧决策） |

**merge 目标集**（与 §4.4 对齐）：仅 `queued/running/paused` 的非终态任务。向 `running` 任务 merge = 插一条 `kind='tool', tool_name='system.note', status='succeeded'` 步（`seq` 递增、带当前 epoch），Runner 下一步决策前 SELECT 最新 note 注入（读侧动作在 §12 骨架已显式列出，修旧稿 issue #16 的"声称会看到但循环没读"）。目标已终态则退化 run_new。

### 6.3 内存水位四级背压（issue #3/#4/#19：删 SIGSTOP、加解冻、重标定阈值）

**旧稿三处硬伤修正**：(a) 协程无法 SIGSTOP，halted 改"给 Runner 传 AbortSignal + 落步收尾"；(b) throttled 只 pause 空闲容器、且必须有 unpause 路径与在途调用保护；(c) 阈值与 netfuzz 常驻矛盾，改为**首启自动基线标定 + 相对 dotd 预留额度**。

```
memory guard 每 5s：memAvail = /proc/meminfo MemAvailable（WSL 内核视角，已含 netfuzz 占用）；
daemonRss = process.memoryUsage().rss（软上限 cfg.daemonRssMaxMb=1024，超限先 GC 提示，
连续 3 次超限只拒绝新建 merge/note，绝不自杀）。
```

**阈值来源（issue #19 的根因）**：`.wslconfig memory=32GB`；netfuzz 常驻 ~20GB 是**基线噪声**、不假设被驱逐（Colibrì 也按尽力而为不计入可让渡，CT:36）。本模块**不写死绝对阈值**，首启进入标定模式：采样 30min 的 MemAvailable 分布，取 `p50=base`；再定 `normal≥base+cfg.dotdReserveMb(默认6GB)`、`guarded≥base+3GB`、`throttled≥base`、`halted<base`。`.wslconfig memory=32GB` + Windows 侧 20GB + netfuzz 波动时，dotd 的 3 容器(6g)+daemon(1g)+Colibrì 尽量塞进 `base` 之上；若 base 本身低于 `cfg.dotdReserveMb`，说明宿主超卖，走"求救事实事件"而非静默 throttled（接缝 S8）。**MVP 兜底固定值**（未标定前）：normal≥10GB / guarded 6–10GB / throttled 3–6GB / halted<3GB——较旧稿 8/5/2.5 整体抬高，避免 netfuzz 在场时永久 throttled。

| 水位 | 队列侧（pop 门控） | 对执行面容器指令 | Runner 协程指令 |
|---|---|---|---|
| normal | 正常 pop | — | — |
| guarded | 正常 pop | 不新起容器（等 idle 回收）；idle 容器 `pause` | — |
| throttled | **停 pop**，queued 不动 | 仅对**无在途调用**的容器 `docker pause`（记 `container_pause`）；对正 `await exec.runTool` 的容器**绝不 pause**（否则该 HTTP 调用无限挂起——旧稿 issue #4）；pause 决策前置判据：该任务无 `started` 工具步 | — |
| halted | 停 pop | `docker kill` 有在途调用的容器（记 `container_kill`），idle 的 `pause` | 给每个 running Runner 协程 `abort()`；Runner 在当前步边界落 journal(ended/interrupted) → 任务 `paused(stop_reason='watermark')`；`shutdownGraceMs=30s` 兜底强退，交 §7 恢复 |

滞回：进 guarded 需 `MemAvail<进入线`，退 guarded 需 `≥ normal 线`；其余类推。所有跃迁写 `resource_events`。

**解冻路径（补 issue #4 缺口）**：每 tick 若 `level` 从 throttled/guarded 回升，对本模块曾 pause 过的容器集合 `docker unpause`（记 `container_unpause`），并把 `paused(stop_reason='watermark')` 任务批量回 `queued`（保 priority）。被 `kill` 的容器对应任务回 `queued`（attempt+1，执行面重建容器）。接缝 S2 要求 `Sandbox.unpause/resume/kill/pause/stats` 四指令（旧稿缺 unpause/resume）。

### 6.4 容器配额与预算执行主体（issue #14：给 budget_tokens 找落点）

- 每容器 `--memory=2g --cpus=2`（MVP 单容器；阶段三多 Dot 每容器 2g，受 §6.3 base 额度约束 ≤6 容器+daemon 1g）。60s `docker stats` 轮询，>1.8g warning，连续 2 周期 >2g 先 pause 再 60s 仍超 kill。
- **token 预算执行主体 = Runner + 本模块 heartbeat 返回位**：`heartbeat(taskId,epoch,{tokens})` 累加 `usage_tokens`；当 `usage_tokens≥budget_tokens` 置 `budget_exhausted=1`，`heartbeat` 返回 `{overBudget:true}`；§12 骨架里 Runner **每步后判该返回值**，为真即主动 `finish(ok:true, summary:'budget')`。硬兜底：`usage≥1.2×budget` 时看门狗旁路 abort（记 `resource_events kind='budget'`），Runner 迟到写被 epoch 围栏拒。旧稿"pop 拦 running 任务"不成立（pop 只筛 queued，已作废）。

### 6.5 磁盘回收

内部 job `queue.gc`（经 §8 registerInternalJob 注册，每日 04:00 本地时区，与 surfaces event_log purge 同刻错峰）：`task_results`/`steps`/`event_decisions`/`journal-blobs` 终态 >30 天清理（steps 删前把摘要写回 task_results.summary），tasks 骨架 >180 天删；`VACUUM INTO` 目标 <500MB，超限先删再 `wal_checkpoint(TRUNCATE)+VACUUM`。`event_decisions` 按 event_log.id 级联（surfaces purge 掉 event_log 行后，本模块清对应 decision）。

---

## 7. 重启恢复流程（R5）

`src/control-plane/recovery.ts`，在 HTTP listen 之前执行。**章节重编号修复旧稿 §7.4 缺失、§7.3 指代错位（issue #17）**：

### 7.1 daemon 启动序列

```
1 open db(~/.dotd/dotd.db), WAL/FULL/busy_timeout; PRAGMA user_version 检查+迁移（失败→拒启动+写 OUTBOX.md）
2 meta 'last_shutdown' = 优雅标记 或 'crash'（无优雅标记=崩溃）
3 recoverInFlight()：
    for task WHERE status='running':
        abort any in-process Runner handle（正常重启无，防御性）
        for open in steps WHERE task_id AND status='started': resolveOpenStep(task, epoch, seq)   // §5.3
        task → queued, attempt+1, run_epoch 保持（下次 pop 再 +1）, priority=min(priority,2)
4 recoverAwaiting()：awaiting_approval 与 paused 原样保留（审批/挂起不随重启丢——库中即状态）
    对 awaiting_approval：查治理 approvals.id 当前态——若审批在停机期间已落定（ok），按 §7.4 的"审批续跑"路径
    转 queued(resume_from_seq)；deny/expired 同理。不依赖内存回调，纯读库（issue #5c：恢复也走上下文重建）。
5 catchUpHeartbeats()：§4.3 surfaces catchup 语义（latest=补1次/skip=不补）
6 replayUndecidedEvents()：§6.1 幂等事务（exists(event_decisions) 短路；deterministicTaskId 防双建）
7 guard.calibrateOrUseFallback()；scheduler.start(所有 registerInternalJob + heartbeat_target 扫描)；http.listen
```

### 7.2 崩溃窗口逐项（修正"幂等"依据）

| 崩溃在 | 库状态 | 恢复 | 后果 |
|---|---|---|---|
| event_log INSERT 前 | 无 event 行 | surfaces 重投/重扫 JSONL（其 jsonl_offset 断点） | 本模块无关，入口有账本 |
| event 已落，未决策 | event_decisions 无行 | 步骤 6 重跑 | 幂等：PK=event_log.id，无二行 |
| 建任务事务中 | task 半写/无 | 事务回滚，步骤 6 重跑 | `deterministicTaskId` 撞 PK，绝不双建（修 issue #1） |
| beginTool 提交后、执行中/后 | started 孤儿 | 步骤 3 `resolveOpenStep` | unknown 先 `exec.reconcileCall`；safe/replayable 重放 |
| endTool 提交前 | started 孤儿（结果丢） | 同上 + 对账 done 则补记 | 不赌"其实没执行"，向执行面取真值 |
| endTool 提交后 | succeeded | 步骤 3 从尾部重建 | 结果注入，不重执行 |
| finish 事务中 | running 无 task_results | 步骤 3：回 queued attempt+1 | 重读 journal 已见全貌，多数步短路 |

### 7.3 messages 重建（LLM 全文归属显式写明，issue #5c/#18）

Runner 重领（经 queued→pop）或审批续跑（§7.4）时**不重放 LLM 请求**，重建顺序固定：

1. `memory.buildSessionReplay(task.threadId, task.id, budget)` → `Message[]`（**assistant 全文在此**：memory.md:289 `content` 对 kind='text' 存正文全文；只有 tool_call/result 是 digest+200 字预览，memory.md:214）。**接缝 S5 明确：恢复所需的 LLM 全量文本由记忆模块负责**（本模块 journal 只存 digest，两头在此对齐，旧稿两头没接住）。
2. 对每条 tool_result 类消息，用其 `call_id` 从 `steps` 取 `result_json` 全文覆盖 digest（`journal.getStepByCallId`）。
3. `journal.tail(task.id)` 补 succeeded 工具结果（buildSessionReplay 未含的尾部步）。
4. `resolveOpenStep` 注入的"结果未知"提示作为 messages 首条（若有孤儿）。

保证：**journal 重建先于 agent 首个决策点完成**。文件记忆 `/dot/home` 先读由 Runner 约定（CT:21），本模块只保证 `run_epoch`/`attempt` 语义不破坏"开始读/结束写"。

### 7.4 Runner 失联 / abort 重领 / 审批续跑（旧稿缺失路径，现正式定义）

三个触发共用一个局部恢复子程序 `reclaimTask(taskId, reason)`：
- 看门狗超时（`running` 且心跳失联）、
- 背压 halted 的 `abort()`、
- 执行面回报 `exec.interrupted(call_id)`（execution.md:242 对账后无 job）—— 该 call 对应的 started 步 `resolveOpenStep` 先处理，若 `replayed` 则 Runner 原地继续、任务不外抛 queued；若 `deferred`（unknown 转审批）则走 awaiting_approval。

```
reclaimTask(taskId, reason):
  abort 该 task 现绑定的 Runner 协程（AbortSignal）
  for started-step: resolveOpenStep()
  若仍留在原地（reason=exec.interrupted 且 replayed）：Runner 直接继续，不动队列
  否则：task → queued, attempt+1（watchdog/halted）；run_epoch 由下次 pop 递增
        abort 后旧协程任何迟到 heartbeat/endTool/finish → epoch 围栏拒绝（§2.2），记 stale_writer
```

**审批续跑**（治理调 `onApprovalSettled`）：`queued(status 先归位)+ resume_from_seq=该 pending 步 seq` → pop 时 `resume_from_seq` 优先（§4.2 ORDER BY）；Runner 领到后从 `steps[resume_from_seq]` 把 `pending→started`（带新 epoch），以治理 `final_params_json` 执行（governance.md:596 认领语义）。deny/expired → 该步 `skipped`，任务回 running 改道或 failed。

---

## 8. 对外接口（其余模块看到的本模块）

```ts
export interface ControlPlane {
  // 队列
  submit(req:{title;goal;priority?;runAt?;dotId?;sourceEventLogId?}): Task;   // 幂等看 event_decisions PK
  pop(dotId?): Task | null;                            // 仅 Runner；内部 run_epoch+1（§4.2）
  heartbeat(taskId:string, epoch:number, usage?:{tokens:number}):
    { overBudget:boolean; aborted:boolean };           // 围栏 + 预算返回位（§2.2/§6.4）
  finish(taskId:string, epoch:number, r:{ok;summary}): void;   // 带 epoch
  cancel(taskId:string, by:'user'|'guard'|'watchdog'): void;
  resume(taskId:string): void;                          // 主人手动 resume paused → queued
  list(q): Task[]; getTask(id): Task|null; getJournal(taskId): Step[];

  // journal（唯一写 steps 路径；两步 + 围栏 + call_id）
  journal: {
    beginTool(taskId,epoch,tool,args,se): { seq:number; callId:string };  // = call_sent
    markPending(taskId,epoch,seq,approvalId): void;                        // 待审批（§5.2/§4.1）
    endTool(taskId,epoch,seq,st,result?): void;                            // = call_done；行数0→拒
    beginLlm(taskId,epoch,promptDigest): number;
    endLlm(taskId,epoch,seq,respDigest): void;
    getStepByCallId(callId): Step | null;                                  // 治理/执行面反查（§5.5）
    reconcileAndResolve(taskId, seq): 'replayed'|'deferred'|'took_result'; // 供执行面 interrupted 回报驱动（§7.4）
    tail(taskId, n?): Step[];
  };

  // 事件（消费 surfaces.event_log，产 event_decisions）
  wakeIngest(): void;                                    // surfaces 落 event_log 后调，触发 §6.1 扫描
  retryMatch(eventLogId:number, m:Match): void;          // 主人手动覆写决策（via='manual' UPSERT）
  listUndecidedEvents(limit?): EventLogRow[];

  // 会话/线程绑定（Runner 首步回写本模块独有 tasks 表，issue #8）
  bindSession(taskId, epoch, {sessionId, threadId}): void;

  // 审批联动（引用治理 approvals.id；issue #12 单一事实源）
  setAwaitingApproval(taskId, epoch, approvalId:number): void;  // 治理→队列（running→awaiting_approval）
  onApprovalSettled(taskId, approvalId, ok:boolean): void;       // 治理回调→§7.4 审批续跑（非直入 running）

  // 背压与预算
  getGuardStatus(): { level; memAvailableMb; baseMb; daemonRssMb; recent:ResourceEventRow[] };
  pauseByReason(taskId, reason:'circuit_open'|'watermark'|'budget'|'tool_risk'): void;  // 模型路由/执行面可调用（补旧稿缺失）
  taskImpact(): {queuedPrimary:number|null; running:number; held:number};   // 注入 ModelRouter.load（model-router.md:721）

  // 统一调度器注册口（治理 cron / 路由 janitor / 内部 gc；issue #7）
  registerInternalJob(spec:{name:string; kind:'light'|'heavy';
                            cron?:string; everyMs?:number; run:()=>Promise<void>}): void;

  // 事件总线
  onBus(event:ControlBusEvent, handler): void;
    // 'task.state'|'task.budget_exhausted'|'guard.level'|'event.undecided'|'stale_writer'
}
```

HTTP（`127.0.0.1:8642`，REST 子集供 Web UI/CLI）：`POST /events/{source}`（→ surfaces.submitEnvelope，非本模块直收）、`GET /tasks`、`POST /tasks`/`/cancel`/`/resume`、`GET /journal/:taskId`、`GET /steps/by-call/:callId`、`GET /guard`。

**对旧稿缺口的补齐**：`pauseByReason`（旧稿 §9 声称提供但接口无）、`registerInternalJob`（治理/路由 cron 无挂口）、`bindSession`（session/thread 只读不写）、`getStepByCallId`/`reconcileAndResolve`（对账无入口）、`taskImpact`（model-router.md:721 要求队列实现 `TaskImpactProvider`）——均已在接口中给出。

---

## 9. 与其他模块的接缝假设（逐条，供仲裁）

**S1 · 执行面 / 工具注册表（强契约）**：每工具导出 `{ name, tierHint, sideEffect:'safe'|'replayable'|'unknown' }`；未标注 = `unknown`（安全默认）。`journal.beginTool` 生成 `call_id`（ULID）先落 steps（= `call_sent`），再调 `ExecService.runTool({callId,...})`——执行面保证同 call_id 至多执行一次、返回必被 `endTool`（=`call_done`）落库后才派下一步（execution.md:247/462）。执行面重启/recreate 造成的未完成调用一律回报 `exec.interrupted(callId)`，**执行面永不自动重试**；本模块经 `journal.reconcileAndResolve` 处置，重放用新 call_id。

**S2 · 执行面 / 容器指令**：本模块决策水位 pause/unpause/kill 与每容器 `--memory=2g --cpus=2`，执行面实施。接口需含 `Sandbox.pause/unpause/resume/kill/stats(): {memMb, hasInflightCall}`——**`hasInflightCall` 是新增强字段**，供 §6.3 "正 await 工具的容器绝不 pause" 判据。镜像/卷回收归执行面。

**S3 · 治理 / 审批单一事实源（issue #12）**：**`approvals` 表归治理，是唯一审批流水**；本模块只引用 `approvals.id`（INTEGER）。surfaces.md:144 的 `approval/approval_response` 双通道回复层应视为治理 approvals 的**投递视图**（TG/Web 回复经 surfaces 转 `governance.decide()`），不接受第二条独立审批流水——本模块 `setAwaitingApproval(taskId, approvalId)` 的 `approvalId` **恒指治理 approvals.id**。`onApprovalSettled(taskId, approvalId, ok)` 的触发方 = 治理 decide() 落定后调用（不是 surfaces）。本模块唯一发起点 = `journal` unknown 孤儿步 → `governance.requestApproval({journalStep:callId, kind:'side_effect_unknown', tool, params})`，落同一张 approvals，与治理规则审批合流（同一 callId 因 `uniq_open_step` 只一张活动单，天然合并）。

**S4 · 治理 / 统一调度器（issue #7）**：治理的 `expirePending`（每5min）、`compactAudit`（每日）与模型路由 `router.janitor`、本模块 `queue.gc`、心跳扫描**全部**经 `ControlPlane.registerInternalJob(spec)` 挂到 scheduler 单点（governance.md:624、model-router.md:373 都要求"控制面统一调度器"）。`kind:'light'` 在 backpressure `throttled/halted` 时跳过一轮（`heavy` 仍跑，gc 属 heavy 但内部错峰）。

**S5 · 记忆 / 会话线程与 LLM 全文归属（issue #5c/#8/#18）**：`tasks.thread_id` 列按 memory.md:178 提供，值由 Runner 首步经 `bindSession(taskId,epoch,{sessionId,threadId})` 回写本模块独有 tasks 表（本模块拥有写权）。恢复重建走 `memory.buildSessionReplay(threadId, taskId, budget)`（memory.md:415 签名，按 thread 不按 session）。**LLM 恢复全量文本由记忆模块负责**（memory.md:289 `content` 存正文全文），本模块 journal 只存 digest（memory.md:214/S6）；工具结果全文以 `call_id` 从 steps 回填。二者接缝在 §7.3 固化。

**S6 · surfaces / 事件表与心跳归属（issue #9/#10）**：`event_log/heartbeat_target/jsonl_offset/approval*` 字段属主 = surfaces（surfaces.md:70），本模块**不再自建 events/crontabs 表**（旧稿删除）。本模块只：① 读 `event_log` 未决策行 ② 写自有 `event_decisions`（PK=event_log.id）③ 代跑 heartbeat_target 到期扫描（其 catchup/quiet_hours/skip_if_busy 语义原样采信 surfaces.md:189）并回写 surfaces 声明"调度器维护"的 `next_due_at/last_fire_seq/last_fired_at/last_fire_status` ④ 触发时调 `surfaces.submitEnvelope()`。**surfaces.event_log 的 dedup_key 可为 NULL**（webhook 无外部 id、TG/Web/CLI）——本模块不要求非空：`event_decisions` 用 event_log.id 做 PK，NULL dedup 行照样可决策、天然幂等（旧稿"dedup_key NOT NULL UNIQUE 撞约束"的隐患消除）。"submit 事务前崩溃 → 入口方自行重试"的账本 = surfaces 的 jsonl_offset + event_log.status（surfaces.md:139/§5.1），本模块不自建。

**S7 · surfaces / 步引用格式（issue #11）**：跨模块引用 journal 步**一律 `call_id`（TEXT ULID）**，对齐 governance.md:438 `approvals.journal_step==ToolCall.callId` 与 execution.md:400 `exec_calls.call_id`。**提请以 surfaces 修改 `approval.step_id INTEGER`→`journal_step TEXT`**（surfaces.md:149），本模块不动 surfaces 文件；本模块提供 `getStepByCallId` 供反查。审计链引用 `(task_id,seq,call_id)`，对外键取 call_id。

**S8 · 模型路由 / 降级与求救（issue #7）**：事件匹配调 `ModelRouter.completeLow({messages,json,timeoutMs:15000})`，全灭抛 `NoChannelAvailable` → `event_decisions` 不建、事件留 surfaces 收件箱。running 中路由熔断：model-router.md:721 约定"队列收到 `AllEndpointsDownError` 置任务 `waiting_model`"——本模块用 `paused(stop_reason='circuit_open')` 承接（不新增 waiting_model 态，接缝请路由对齐术语），经 `ControlPlane.pauseByReason(taskId,'circuit_open')`；订阅 `router.mode_changed` 恢复→回 queued。路由需队列注入 `TaskImpactProvider`（同步 O(1) 返回 `{queuedPrimary,running,held}`），本模块 `taskImpact()` 实现（model-router.md:673/721）。halted/水位/预算事实经总线 `guard.level`/`task.budget_exhausted` 供路由求救逻辑订阅；本模块不发 Telegram/email/OUTBOX。

**S9 · 交互面 / Dot Runner**：Runner 是同进程协程（非子进程），只用 `pop→bindSession→[beginLlm/endLlm | beginTool→(markPending|endTool)]→heartbeat(带epoch)→finish(带epoch)`；Web UI 审批卡片数据源 = `GET /journal/:taskId`+`GET /tasks`+治理 approvals。HTTP 绑 127.0.0.1:8642；Web UI（surfaces）7788 转发。

**S10 · 全库 / 迁移与命名（issue #13）**：单库 `~/.dotd/dotd.db`，`PRAGMA user_version` 迁移由本模块 db 层统一管理（governance.md:429 已把此权归"控制面 db 模块"）。表名无模块前缀（采信 governance.md:429"前缀不强制"+surfaces 现实现；memory.md:376 的 `mem_` 前缀保留给记忆，不要求全库加前缀）。铁律：**不建跨模块所有权外键**——本模块 `tasks.source_event_log_id/thread_id/session_id`、`steps.approval_id` 皆弱引用；同属主（`task_results→tasks`）可建。提请仲裁点：governance.md:426 的库名 `control.db` 应改为 `dotd.db`（接缝 S10）。

---

## 10. 遵守的 CONTEXT 约束清单

| CT 出处 | 约束 | 本文落点 |
|---|---|---|
| CT:9 | 完全自主、零商业托管、模型 API base_url 可换 | 队列/journal/事件/决策全本地 SQLite；无云持久化 |
| CT:18 | TS 单进程 daemon(Node24)+SQLite（队列/journal/审批/事件日志/会话/熔断同库） | §2 零 worker；§1.3/§9-S10 单库 user_version 迁移 |
| CT:17 | 事件入口清单 HTTP/JSONL/心跳/邮件(阶段二) | §6.1/§4.3 入口经 surfaces 统一 submitEnvelope；email 阶段二占位 |
| CT:16 | Web UI 展示队列/熔断状态 | `GET /tasks`、`GET /guard`、resource_events |
| CT:21 | 文件记忆任务开始读结束写；SQLite 会话历史；不上向量 | §7.3、S5；匹配用最近任务摘要 top20 非向量 |
| CT:27 | 低智能高频分流走本地模型 | §6.1 规则层①优先、模型层② completeLow |
| CT:29 | 应急收缩范围、登录态转审批 | §5.3 `treatUnknownAsRisk`（应急强制 true） |
| CT:33 | processor group 教训 | §2.1-3 WSL 内改用 .wslconfig memory=32GB/processors=24 并说明 |
| CT:34 | daemon 跑 WSL、UI localhost 转发、宿主无 docker | HTTP 绑 127.0.0.1:8642；经 WSL docker.sock |
| CT:35 | 与 netfuzz 20GB/CPU 共存、不假设独占 | §6.3 相对基线标定四级水位+滞回、§6.4 容器硬配额、只读实际 MemAvailable |
| CT:36 | Colibrì 尽力而为、可探测降级 | §6.1 全灭落 inbox、§6.3 S8；Colibrì 不计入可让渡资源 |
| CT:37 | journal/卷/镜像占用上限与回收 | §3 32KB blob 截断、§6.5 TTL+VACUUM、dotd.db≤500MB |
| CT:44 | 崩溃安全步骤级 journal、绝不重复执行 | §5 两步协议+call_id 幂等对账+unknown 先 reconcile |
| CT:45 | serve 重启不丢队列；scheduled turns；事件→目标带置信度理由；127.0.0.1 UI | §7、§4.3 heartbeat_target、§6.2 置信度、端口绑定 |
| CT:51 | MVP 单人单 Dot 约 2 周 | maxRunningTasks=1、dot_id 预留、阶段二/三项标占位 |

---

## 11. 开放问题（需仲裁或主人拍板）

1. **`docker pause` 在 WSL2 cgroup-freezer 可用性未实测**：§6.3 throttled/guarded 依赖它。动工首日实测一次；不可用则 throttled 退化"仅停 pop、idle 容器不 pause"（内存让渡慢），需仲裁是否接受降级方案。
2. **merge 注记即时性**：merge 信息在 agent 下一决策点生效（每步一次 SELECT note）。若需"立刻打断"（如"停止改 X"），要 Runner 每次 beginTool 前检查；MVP 建议接受延迟，阶段三再议 interrupt 通道。
3. **水位阈值最终数值依赖首启标定**：§6.3 兜底固定值（normal≥10GB 等）是 netfuzz 常驻 20GB 下的保守线；若 netfuzz 实为 WSL 之外运行（与 CT:35 表述相反），线需重定。需主人确认 netfuzz 负载的确切位置，标定模式方能给出 base。
4. **`HEARTBEAT_TIMEOUT_MS=180s` 与路由单请求超时未对齐**：慢模型单步 LLM 可能超时导致误触发 §7.4 reclaimTask（虽 epoch 围栏已防双 Runner，但无谓 attempt 递增）。需与 model-router 定 `HEARTBEAT_TIMEOUT ≥ routerTimeout×重试+toolTimeout`，数值待定。
5. **surfaces/governance 两处 schema 归一**（本文不擅改他模块）：① 库名 `control.db`→`dotd.db`；② surfaces `approval/approval_response` 与 governance `approvals` 双流水需合并（S3 立场：approvals 唯一，surfaces 层降为投递视图）；③ surfaces `approval.step_id INTEGER`→`journal_step TEXT=callId`（S7）。三处需仲裁拍板后同步到对方文档。
6. **crontab 时区**：heartbeat_target 的 cron/interval 按 WSL 本地时区解释（cron-parser tz 支持）；`quiet_hours` 亦本地。默认 `Asia/Shanghai`，待确认。

---

## 12. 关键伪码：Runner 与队列完整交互（集成测试骨架，已修旧稿 issue #16）

```ts
// dotRunner.ts —— 展示 S9 全部时序；可直接作集成测试骨架
const loop = queue.popLoop();                       // §4.2，throttled/halted 时挂起
for await (const task of loop) {                    // task.runEpoch 为围栏凭据（S9）
  const epoch = task.runEpoch;
  if (!task.threadId) {                             // 首步绑定会话（S5，修旧稿只读不写）
    const { sessionId, threadId } = await memory.openThread(task.dotId, task.goal);
    queue.bindSession(task.id, epoch, { sessionId, threadId });
  }
  const ctx = await memory.buildSessionReplay(task.threadId, task.id, task.budgetTokens); // §7.3 LLM 全文来自记忆
  await memory.readFileNotes(task.dotId);           // /dot/home 先读（CT:21）
  for (const s of journal.tail(task.id))
    if (s.kind==='tool' && s.status==='succeeded') ctx.feedToolResult(s.callId, s.resultJson); // 全文从 steps 回填
  for (const n of journal.pendingNotes(task.id))    // merge 注记读取动作（旧稿缺，此处显式 SELECT）
    ctx.feedSystemNote(n);
  ctx.push(...journal.openStepNotes(task.id));      // §5.3 结果未知提示（若有）

  while (!ctx.done) {
    const step = ctx.nextStep();
    if (step.type === 'tool') {
      const se = toolRegistry[step.name].sideEffect ?? 'unknown';         // S1
      const { seq, callId } = journal.beginTool(task.id, epoch, step.name, step.args, se); // = call_sent
      const verdict = await governance.evaluate(task.id, callId, step);   // allow|approve|deny
      if (verdict.kind === 'approve') {
        const ap = await governance.requestApproval({ journalStep: callId, ... });
        journal.markPending(task.id, epoch, seq, ap.id);
        queue.setAwaitingApproval(task.id, epoch, ap.id);                 // 挂起；恢复经 §7.4 审批续跑
        break;
      }
      const res = await exec.runTool({ callId, taskId: task.id, tool: step.name, args: verdict.finalParams });
      journal.endTool(task.id, epoch, seq, res.ok?'succeeded':'failed', res.value); // = call_done；行数0→拒
      ctx.feed(res);
    } else {                                                              // LLM 分支两步协议齐全（旧稿缺 endLlm）
      const seq = journal.beginLlm(task.id, epoch, ctx.digest());
      const resp = await modelRouter.completeMain(...);
      journal.endLlm(task.id, epoch, seq, resp.digest);
      ctx.feed(resp);
    }
    const hb = queue.heartbeat(task.id, epoch, { tokens: ctx.tokensThisStep });  // 围栏 + 预算位
    if (hb.aborted) break;                       // 背压/看门狗已 abort，交 reclaimTask
    if (hb.overBudget) { queue.finish(task.id, epoch, { ok:true, summary:'budget' }); break; } // §6.4 预算落点
  }
  if (ctx.done) {
    await memory.writeFileNotes(task.dotId);      // 结束写（CT:21）
    queue.finish(task.id, epoch, { ok:true, summary: ctx.summary });
  }
}
```

---

## 13. 评审响应（逐条）

> 行号引用指评审所依据的旧稿行；修复后位置以本版为准。

1. **崩溃重复建任务（旧 §7:428、§7.1:438）**：旧稿把 surfaces 的事件行去重误当建任务去重。本版 §6.1 规定"**建任务+写 event_decisions 同一 `BEGIN IMMEDIATE` 事务**"，并令 `task_id=deterministicTaskId(event_log.id)='tk_ev_'+id`（PK 派生），重放撞主键即回滚，绝无双建。§7.2 表同步改写"幂等依据=event_decisions PK + task PK 派生"，删除错误的 dedup_key 论断。

2. **watchdog 误判双 Runner（旧 §4.1:243、§12:568、§11.4:544）**：旧稿无围栏。本版 §2.2 引入 `tasks.run_epoch`：转 running +1，Runner 所有回写带 epoch，UPDATE `WHERE run_epoch=?` 行数 0 即拒并记 `stale_writer`；旧协程迟到 endTool 无法把 interrupted 行改回。§7.4 把"Runner abort 后重领"正式定义为 `reclaimTask`（abort→resolveOpenStep→epoch 递增），三触发（watchdog/halted/exec.interrupted）共用。§4.1 看门狗路径显式补 abort 信号。旧"开放问题 #4"升级为本文机制。

3. **halted SIGSTOP 与协程矛盾（旧 §2.1:45、§6.3:395）**：本版 §6.3 halted 改为"给 running Runner 协程传 `AbortSignal`，在当前步边界落 journal→paused，`shutdownGraceMs=30s` 兜底强退交恢复"。§2.1-4 澄清唯一 child_process 是 docker 命令、非 Runner；协程不能 SIGSTOP。

4. **throttled pause 无解冻 + 在途调用挂起（旧 §6.3:394、§9.2:507）**：本版 §6.3 规定 throttled **只 pause `hasInflightCall=false` 的容器**，正 await 工具的容器绝不 pause（消除 HTTP 无限挂起）；补 unpause 解冻路径（水位回升对本模块 pause 过的集合 `docker unpause`，记 `container_unpause`）；S2 接口加 `unpause/resume/hasInflightCall`。

5. **awaiting_approval 的 journal 步态未建模（旧 StepStatus:74、§7.2:447）**：本版 §3 `StepStatus` 增 `pending`（待审批，非孤儿）与 `skipped`（审批 deny/expired）。恢复扫描只认 `started`，pending 不误标（§4.1 硬门控 3）。§4.1 门控 1：审批放行 ok→**queued**（带 resume_from_seq），非直入 running，杜绝绕过 maxRunning（门控漏洞消除）。§7.4+§7.1 步骤 4：awaiting_approval 重启后查治理 approvals 当前态走审批续跑路径，上下文重建统一经 §7.3。

6. **接缝 1 幂等写漏一半（旧 §5.2:299、§5.3/§9.1:506）**：本版 §5.2 `beginTool` 落 started 行即 `call_sent`、`endTool` succeeded 即 `call_done`，call_id 存 `steps.call_id`+`uq_steps_call` 供执行面 `exec_calls` JOIN（execution.md:400）；§5.3 unknown 步先 `exec.reconcileCall(callId)`，done 补记 / aborted 重放 / 未知转审批；§7.4 定义 `exec.interrupted(callId)` 回报 → `journal.reconcileAndResolve` 对账流程。

7. **被调用方法不在接口清单（旧 §9.4:509 pauseByReason）**：本版 §8 补 `pauseByReason`（路由 circuit_open/水位/budget）、`registerInternalJob`（治理 expirePending/compactAudit + 路由 janitor + 内部 gc + 心跳扫描，S4）、`bindSession`、`getStepByCallId`、`reconcileAndResolve`、`taskImpact`（S8）。§1.1 R7 + §4.3/§6.5 说明这些 cron 的唯一宿主。

8. **会话/线程只读不写（旧 §9.5:510）**：本版 §8 加 `bindSession(taskId,epoch,{sessionId,threadId})`，§12 骨架首步调用；§7.3 恢复用 `buildSessionReplay(threadId,taskId)`（对齐 memory.md:415 按 thread 的签名，非 session）。session_id 不再恒 NULL。

9. **事件表双所有权/键空间冲突（旧 §3.1.3:177）**：本版 §1.3/§6.1/S6 删除自有 `events` 表，改为读 surfaces `event_log` + 写自有 `event_decisions`（PK=event_log.id）。surfaces dedup_key 可 NULL 的问题消除（不依赖 dedup，靠 event_log.id PK）。JSONL/入口重放账本归 surfaces jsonl_offset，接缝写明（旧 §7.1"入口方重试"前提落实为 surfaces 持有）。

10. **心跳调度器与 surfaces 重复拥有（旧 §3.1.4:189 crontabs）**：本版删 `crontabs` 表，S6 定 surfaces `heartbeat_target` 为唯一属主、本模块 scheduler 代跑判定循环并回写其声明"调度器维护"的列；补跑语义采信 surfaces `catchup∈{latest,skip}`，删旧"合并1次且k>5丢弃"。

11. **"步"三模块三键（旧 §5.3:333、§9-3、审计:344）**：本版 §5.5 统一对外步引用=`call_id`(TEXT ULID)，对齐 governance.md:438/execution.md:400；内部 (task_id,seq) 不外泄；`forceApproval`→`requestApproval({journalStep:callId,...})` 字段与 approvals 必填列（tool/tier/params/summary 由执行面 registry 补齐）；审计引用改述 (task_id,seq,call_id)。surfaces `step_id INTEGER` 冲突记 S7 提请改（不擅改 surfaces 文件）。

12. **审批数据结构三套/回调不通（旧 §8、§5.3:333）**：本版 S3 定 `approvals`(治理) 为唯一事实源，`approvalId` 恒指 approvals.id；`onApprovalSettled` 触发方=治理 decide()；surfaces `approval/approval_response` 降为投递视图；本模块 forceApproval 与治理规则审批经 `uniq_open_step`+同 callId 合并为一单。开放问题 #5 提请 surfaces/governance 流水归一。

13. **库文件/迁移三处冲突（旧 `db/main.db`:212、meta:215）**：本版 §1.3 统一 `~/.dotd/dotd.db`、`PRAGMA user_version`（governance.md:429 授权控制面 db 模块管）、删自有 meta 版本行；表名不加前缀（采信 governance.md:429/surfaces）；§9-S10 铁律"不建跨所有权外键"，删 `tasks.source_event_id REFERENCES events`、`steps REFERENCES tasks` 的跨/混合 FK。库名 `control.db`→`dotd.db` 与 governance 的 FK 方向列入开放问题 #5 提请仲裁。

14. **budget_tokens 无执行主体（旧 §9.4:509）**：本版 §6.4 明确主体=Runner+`heartbeat` 返回 `overBudget`（usage 超 budget 置位），§12 骨架每步判 hb.overBudget→finish；硬兜底 usage≥1.2×budget 看门狗旁路 abort。删除旧"pop 拦 running"（pop 只筛 queued）不成立表述。§5.4 澄清硬上限是步数、token 预算另属 §6.4。

15. **淘汰复用 disk_gc 且 merge 条件矛盾（旧 §4.4:277）**：本版 §3.1.4 枚举加 `queue_evict`/`container_pause`/`container_unpause`/`stale_writer`/`watchdog`/`budget`（旧只有 disk_gc/container_kill/watermark/ws_oom）；§4.4 淘汰记 `queue_evict`，固化 merge 目标集=既有非终态任务、被淘汰=另一批自动任务（incoming 未落库无 merge 自身），失败判定=无同目标才淘汰队首最低优先自动任务。

16. **验收伪码违反自身契约（旧 §12:555 memory.load、:570 缺 endLlm、note 无读）**：本版 §12 改用 `memory.buildSessionReplay`（§9.5/§7.3 规定的签名）、LLM 分支 beginLlm+endLlm 齐全、补 `journal.pendingNotes` 读取动作、beginLlm 返回值接住、beginTool 返回 {seq,callId}、heartbeat/finish 带 epoch、budget abort 处理。

17. **内部交叉引用断裂（旧 §5.3:316 指 §7.3/§7.4、§7 仅 7.1-7.3）**：本版 §7 重编号为 7.1（启动）/7.2（窗口表）/7.3（messages 重建）/7.4（失联+abort 重领+审批续跑，旧稿缺失路径现已正式定义）；§5.3 引用改指"daemon 重启 §7.1、Runner abort/对账重领 §7.4"，指代自洽。

18. **恢复依赖未确认前提（旧 §5.2:307、§9.5:510）**：本版 §7.3 步骤 1 显式写明"LLM 恢复全量文本由记忆模块负责（memory.md:289 content 存正文全文）"，S5 同步；journal 只存 digest、工具结果全文以 call_id 从 steps 回填，两头在 §7.3 接住，不再"两头都没接住"。

19. **水位阈值与 .wslconfig 不自洽（旧 §2.1-3:55、§6.3:392）**：本版 §2.1-3 将 `.wslconfig memory` 从 24GB 提至 32GB；§6.3 阈值改**首启相对基线标定**（采样 MemAvailable p50=base，四档按 base+预留），并给 netfuzz 常驻下的保守兜底固定值（normal≥10/guarded 6-10/throttled 3-6/halted<3GB，整体抬高），删除旧"normal≥8GB 数学上不可达"的死配置；base 低于 dotdReserve 时走求救事实事件（S8）而非静默 throttled。netfuzz 确位问题列开放问题 #3 请主人确认。

---

## 附：DDL 校验记录

本版 DDL（tasks 新列 run_epoch/resume_from_seq/budget_exhausted/stop_reason-CHECK、steps 新列 status pending/skipped + approval_id + run_epoch + `uq_steps_call`、event_decisions、resource_events 新枚举）**已在本 ask 内用 WSL sqlite3 实测通过**（见本次校验命令与输出，命令与结果见提交说明）。
