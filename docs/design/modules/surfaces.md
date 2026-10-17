# 模块详设：交互面与事件入口（surfaces）· rev2

> 契约来源：`dotd-design/CONTEXT.md`（下称 CONTEXT）；已定稿的兄弟模块 `control-plane.md`（CP）、`governance.md`（GOV）、`model-router.md`（MR）为对账依据。
> **rev2 总原则：表与状态机的属主归其定义模块，本模块只做适配层。** 本文件不再自带任何 `approval`/`event_log` DDL；属主声明见 §2.0。
>
> 命名对账：daemon 入口 `dotd`；数据目录 `~/.dotd/`（WSL）；默认 dot id = `dot1`（CP:133 `dot_id DEFAULT 'dot1'`，rev1 误写 'main'，已改）。

---

## 1. 模块职责与边界

**A. 人机面**：本地 Web UI（聊天流、审批卡片、队列/熔断视图）；Telegram bot（出站长轮询、指令解析、审批双通道之一）；CLI（daemon 的 HTTP 瘦客户端，`dotd serve` 为 daemon 本体入口）。

**B. 事件入口**：HTTP/webhook、JSONL 文件监听、心跳调度器三个机器入口；本模块只做 **鉴权 → 规范化 → 限流 → 幂等键生成 → 投递**，事件的落库、匹配、建任务全部在 CP。

**边界（不属于本模块）**：
- 事件表 `events`、任务队列、journal、会话历史 → CP 属主。本模块只调 `cp.ingestEvent()` / `cp.submit()`，只读快照做展示。
- 审批状态机与 `approvals` 表 → GOV 属主。本模块是 GOV `decide()`/`resolveTelegram()` 的**通道适配层**：收集人输入、渲染卡片、edit 通知。不自建审批表、不自建状态机、不判定"什么操作需要审批"。
- 求救的判定、去重、OUTBOX 兜底 → MR 属主。本模块只提供 MR 所需的 `NotificationChannels.deliver()` 传输适配器（§5.7），不写 OUTBOX。
- 队列优先级语义、淘汰规则 → CP 属主。本模块只提供映射表（§5.1）。

铁律（rev2 修订）：**一条入站激励恰好命中下表中的一条投递路径，不存在旁路写库**：

| 激励 | 投递路径 |
|---|---|
| webhook / JSONL 行 / 心跳 / Telegram 聊天消息 | `cp.ingestEvent({source, payload, dedupKey})` |
| Web UI / CLI 主动聊天与手动任务 | `cp.submit({title, goal, priority, dotId})`（CP:461，manual 任务） |
| 审批回复（web/TG/CLI 任一通道） | `gov.decide()` 或 `gov.resolveTelegram()`（GOV §3.3/§3.4，S3/S4 接缝），**绝不进事件流** |

---

## 2. 技术选型与表属主声明

### 2.0 表属主矩阵（仲裁基准）

| 表 | 属主 | 本模块的使用方式 |
|---|---|---|
| `events`、`tasks`、`steps`、`crontabs` | CP（CP:131-200） | 经 `ingestEvent/submit/list/getJournal` 与心跳 tick 读写 `crontabs.next_fire`；REST 只读展示 |
| `approvals`、`approval_rules`、`audit_log` | GOV（GOV:432-470） | 只读 `ApprovalView`（GOV §3.5）+ 调 `decide()`；不 UPDATE 这些表 |
| `alert_dispatch` | MR（MR:335-350） | 不涉及（MR 自管账本） |
| `jsonl_offset`、`heartbeat_state`、`tg_card_state`、`ingress_rejects`、`sse_cursor` | **本模块** | 全量 DDL 见 §4，是唯一由本模块交付的迁移包 |

### 2.1 选型

| 项 | 选型 | 理由 |
|---|---|---|
| Web 前端 | Vite + React 18 + TS，无组件库，纯 CSS | 单机自用，2 周 MVP 约束 |
| 实时通道 | SSE（不用 WebSocket） | 单向推送够用；游标方案见 §4.5（rev2：独立 `bus_seq`，不再借事件表 id） |
| HTTP 框架 | Node 24 内置 `http` + 自写路由，**全 daemon 唯一监听 `127.0.0.1:7788`** | rev2 对账：CP:497 的 "HTTP :8642 REST 子集" 由本模块的路由器实现为内部路由（直调 CP 函数），**CP 不开第二监听**；两端口共存会破坏"单进程 daemon"与鉴权统一。此为对本模块边界的新声明，列入开放问题 Q0 供仲裁 |
| CLI | `commander` + stdlib `fetch` | — |
| Telegram | 直连 Bot API `getUpdates` 长轮询，无框架库 | 出站方向 NAT 友好，符合 CONTEXT:22"Telegram 优先"且零托管依赖 |
| 文件监听 | `chokidar` 4 | — |
| cron | `cron-parser`（与 CP crontabs 同一库） | — |

### 2.2 拓扑与资源

同 rev1：daemon 单进程内运行 Web 服务器、SSE 总线、TG 轮询、JSONL watcher、心跳 tick；`nice -n 10`、`--max-old-space-size=1024`、SSE 连接 ≤8、TG 出站 1 msg/s/聊天；Windows 侧经 portproxy 访问 7788（§9）。

分期（rev2 消除矛盾）：**阶段一交付 HTTP 入口 + 心跳 + Web UI + CLI；JSONL 监听接口与 offset 表在阶段一即定型、默认 `enabled:false`（工期富余可开启，不阻塞验收）；Telegram 全量在阶段二**（对齐 CONTEXT:51-52）。

---

## 3. 配置（`~/.dotd/config.yml` 的 `surfaces:` 节）

```yaml
surfaces:
  http:
    host: 127.0.0.1
    port: 7788
    master_token: "${DOTD_MASTER_TOKEN}"
    readonly_tokens: ["${DOTD_RO_TOKEN}"]
    allowed_origins: ["http://localhost:7788", "http://127.0.0.1:7788"]
  hooks:
    - source: grafana
      secret: "${HOOK_GRAFANA}"
      dot_id: dot1
      rate_limit_per_min: 30
  jsonl_watch:
    - path: ~/dots/inbox/*.jsonl
      dot_id: dot1
      enabled: false          # 阶段一定型默认关，见 §2.2 分期
      idle_debounce_ms: 500
  heartbeat:
    tick_interval_s: 15       # 扫描 CP crontabs 表（CP:191-200）
  telegram:
    bot_token: "${TG_BOT_TOKEN}"
    allowlist: [123456789]
    edit_throttle_ms: 1200
  ui:
    stream_deltas: true
```

---

## 4. 本模块自有表（全量 DDL，唯一迁移包）

```sql
-- surfaces/schema.sql —— 前缀 surf_ 避免与 CP/GOV 迁移撞名
CREATE TABLE surf_jsonl_offset (
  path       TEXT PRIMARY KEY,
  inode      INTEGER NOT NULL,
  gen        INTEGER NOT NULL DEFAULT 0,   -- 旋转代数，参与 dedup_key，见 §5.3
  byte_off   INTEGER NOT NULL,             -- 只停在完整行边界
  updated_at TEXT NOT NULL
);

CREATE TABLE surf_heartbeat_state (        -- CP 拥有 crontabs 调度事实；本表存行为扩展
  ct_id            TEXT PRIMARY KEY REFERENCES crontabs(id),  -- 'ct_'+nanoid（CP:193）
  skip_if_busy     INTEGER NOT NULL DEFAULT 1,
  quiet_hours      TEXT,                    -- '23:00-07:30' 本地时区，命中则跳过
  catchup          TEXT NOT NULL DEFAULT 'latest' CHECK (catchup IN ('latest','skip')),
  last_fire_seq    INTEGER NOT NULL DEFAULT 0,
  last_fire_status TEXT                    -- fired|skipped_quiet|skipped_busy|error
);

CREATE TABLE surf_tg_card_state (          -- 审批 TG 卡片状态（属主表在 GOV，这里只存通道侧事实）
  approval_id  INTEGER PRIMARY KEY REFERENCES approvals(id),
  chat_id      INTEGER NOT NULL,
  message_id   INTEGER NOT NULL,
  reminded_at  TEXT                        -- 过期前提醒只发一次的标记（rev2 补缺口⑬a）
);

CREATE TABLE surf_ingress_rejects (        -- 从未抵达 CP 的入站失败的审计（CP events 收不到它们）
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  source  TEXT NOT NULL,                  -- 'http'|'file'|'heartbeat'|'telegram'|'webui'|'cli'
  actor   TEXT,
  reason  TEXT NOT NULL CHECK (reason IN ('auth','origin','rate','schema','size','allowlist','parse')),
  detail  TEXT
);

CREATE TABLE surf_sse_cursor (             -- 总线游标（rev2：独立单调号，见 §4.5）
  k    INTEGER PRIMARY KEY CHECK (k = 1),
  seq  INTEGER NOT NULL
);
```

`dedup_key` 生成规则（传给 `cp.ingestEvent`，命中 `events.dedup_key UNIQUE`，CP:179）：

| 来源 | dedup_key |
|---|---|
| heartbeat | `hb:<ct_id>:<next_fire_epoch_ms>`（CP crontabs 每次触发的到期时刻天然唯一，rev2 弃用自造 fire_seq） |
| JSONL 行 | `file:<path>:<inode>:<gen>:<行号>`（gen 解决截断旋转冲突，§5.3） |
| webhook | `<source>:<payload.id ?? payload.delivery_id ?? sha256(body)[0:16]>` |
| Telegram 聊天 | `tg:<update_id>`（长轮询重拉的幂等锚，§5.5） |

## 4.5 SSE 事件总线（内存）

```ts
export type BusChannel = 'chat' | 'approval' | 'queue' | 'breaker' | 'step' | 'log';
export interface BusEvent<E = unknown> {
  seq: number;                 // surf_sse_cursor 单调计数器，重启续读（+1 每 publish）
  channel: BusChannel; kind: string; at: string; dotId: string; payload: E;
}
```

- rev2 更正：游标**不借** CP `events.id`（那是 `'ev_'+hash` 字符串，CP:107，不可排序）也不借审批 id。全部 publish（含瞬态 `chat.delta`）统一取自 `bus_seq` 计数器；重启从 `surf_sse_cursor` 恢复。
- `Last-Event-ID` 语义：游标落后于 head 且 ≤5000 条内、且该通道可由属主表重建（approval 由 GOV `listPending()`、queue 由 CP `list()`），则重放快照事件；否则发 `{"kind":"resync"}`，客户端对 `queue/breaker/approval` 各拉一次 REST 校正。
- `chat.delta` 仅进总线不落库，每订阅者队列上限 200，溢出丢 delta，靠 `chat.final` 校正。
- 上游事件名映射（直接订阅，不重造）：GOV `approval:created/decided/expired/revoked/claimed`、`governance:quarantine`（GOV §8 表）、MR `router.mode_changed`（MR:526）、CP `onBus('task.state'|'guard.level'|...)`（CP:492）→ 分别转发到本总线对应 channel。

### 4.6 入口规范化类型

```ts
export interface RawInbound {
  source: 'http' | 'file' | 'heartbeat' | 'telegram';   // 与 CP events.source CHECK 逐字一致（CP:145）
  dotId: string;
  text?: string;
  payload: unknown;
  dedupKey?: string;
  actor: string;            // 'hook:grafana' | 'file:<path>' | 'tg:<chat_id>' | 'scheduler'
}
export interface IngressDeps {
  cp: { ingestEvent(e: RawIngress): { eventId: string; decision: MatchDecision | null } };  // CP:485
  bus: EventBus;
  now(): Date;
  activeTaskCount(dotId: string): number;   // 实现 = cp.list({status:['queued','running']}).length（CP:471）
}
```

> rev2 删除：Envelope 整体作废——`enqueue(env)` 是 rev1 虚构接口，真实投递面就是 CP 的 `ingestEvent`/`submit` 两函数；`approvalReply` 字段删除（审批回复走 GOV 接口，不建事件，修复缺口⑨）；`priority` 三档枚举删除，改为提交时映射整数（§5.1）。

---

## 5. 关键流程

### 5.1 统一入口函数 `ingest()`（仅机器事件；审批与手动聊天不经此路）

```ts
export function ingest(raw: RawInbound, deps: IngressDeps): { eventId: string; dup: boolean } {
  const r = zodValidate(raw);                       // 失败 → insert surf_ingress_rejects(reason='schema') → 4xx
  if (rateLimiter.exceeded(raw.source, raw.actor))  { reject('rate'); return http429(); }
  if (!originAllowed(raw))                          { reject('origin'); return http403(); }  // 防 DNS rebinding
  const { eventId, decision } = deps.cp.ingestEvent(rawToIngress(raw)); // 事件落库/去重/匹配全在 CP（CP:360）
  deps.bus.publish('log', { kind: 'event.received', eventId, source: raw.source, dotId: raw.dotId });
  return { eventId, dup: decision === null && alreadyKnown(eventId) };
}
```

**优先级映射**（修复缺口⑪）：入口不再携带抽象档位，按来源映射到 `tasks.priority INTEGER`（CP:134，0 最高）：

| 来源 | 提交函数 | priority |
|---|---|---|
| Web UI / CLI 聊天、手动任务 | `cp.submit` | 1（interactive，主人任务，CP:277 永不淘汰） |
| Telegram 聊天 | `ingest`（source='telegram'） | 1 |
| heartbeat / webhook | `ingest` | 5（CP 默认值） |
| JSONL 批量 | `ingest`（source='file'） | 7（bulk，最先被淘汰——与 CP:277 "只淘汰 file/http 自动任务" 一致） |

CP 若因超 `maxQueued=200` 拒绝/淘汰（CP:277），`ingest` 把 HTTP 响应映射为 `503 {"retryAfterMs":…}` 供 hook 方重投，本模块不自行排队。

### 5.2 HTTP API（监听唯一、鉴权统一）

鉴权：`Bearer master_token`；`readonly_tokens` 仅 GET；带 `Origin`/`Referer` 必须命中白名单；hooks 用 HMAC——`X-Dotd-Timestamp`（±300s）+ `X-Dotd-Nonce`（LRU 5k 防重放）+ `X-Dotd-Signature: sha256=hex(hmac(ts\n nonce\n body))`；body ≤256KB。

| 方法/路径 | 转发到（rev2 全部写明属主） |
|---|---|
| GET `/api/health` · `/api/whoami` | 本模块 |
| POST `/api/messages` `{text}` | `cp.submit({title: text.slice(0,60), goal: text, priority: 1})` |
| GET `/api/queue?dot=` | `cp.list()` 投影 |
| POST `/api/queue/:id/cancel` | `cp.cancel(id,'user')` |
| GET `/api/conversations?dot=&before=&limit=` | 记忆模块会话 API（经 CP/内存进程函数，memory.md 属主） |
| GET `/api/approvals?state=pending` · `GET /api/approvals/:id` | `gov.listPending()` / `ApprovalView`（GOV §3.5） |
| POST `/api/approvals/:id/decision` `{verdict:'approve_once'|'approve_remember'|'reject', note?}` | `gov.decide(id, 'web'|'cli', verdict, actor)`（**唯一写路径在 GOV**，GOV:232；本端点只是适配器） |
| GET `/api/events?since=` | CP `events` 表分页（内部函数读，id 为 TEXT 按 `received_at` 排序分页） |
| GET `/api/guard` · `/api/breaker` · `/api/models/rank` | `cp.getGuardStatus()`（CP:490）/ MR 状态查询（MR §7 接口） |
| GET `/api/stream?topics=…` | SSE，游标 = `bus_seq`（§4.5） |
| POST `/api/hooks` · `/api/heartbeat`（CT 增删改） | 写 config.yml（hooks）/ 写 CP `crontabs` + `surf_heartbeat_state`（心跳），热重载 |
| POST `/hooks/:source` | §5.1 `ingest`，`202 {eventId}`；dup 命中 `200 {eventId, dup:true}`（CP:485 返回旧行） |

### 5.3 JSONL 文件监听

- chokidar watch glob；每文件状态机 `open→tail→idle(debounce 500ms)→closed`。
- offset 只在"完整行 + ingest 成功返回"后前进（`surf_jsonl_offset.byte_off` 落库同事务）；半行不消费。
- **旋转与截断（修复缺口⑧）**：
  - inode 变化（mv+新建）→ `gen++`，从 0 重读；
  - `size < byte_off`（截断重写，同 inode）→ 同样 `gen++`，从 0 重读，并在 `log` 通道发告警；
  - dedup_key 含 `gen`（§4 表），新内容第 1 行 = `file:<path>:<ino>:<gen+1>:1` ≠ 旧行，不会再被误判 dup。
- 解析失败行不阻塞：写 `<path>.errors.jsonl` + `ingress_rejects(reason='parse')`；连续 20 行坏 → 暂停该 path + `log` 告警。

### 5.4 心跳调度器

rev2：调度事实存 CP `crontabs`（CP:191-200，入表即算好 `next_fire`），本模块只做 tick 循环与行为扩展（`surf_heartbeat_state`）：

```ts
async function tick() {
  const due = db.all(`SELECT * FROM crontabs WHERE enabled=1 AND next_fire <= ?`, now());
  for (const ct of due) {
    const st = getOrCreateHeartbeatState(ct.id);
    // 先推进 next_fire（UPDATE crontabs SET next_fire = cronParser(ct.cron, now).getTime()）
    //   —— 先推进后投递：崩溃窗口内宁可漏一次，绝不补发一排 heartbeat 风暴
    if (inQuietHours(st.quiet_hours)) { mark(st,'skipped_quiet'); continue; }
    if (st.skip_if_busy && deps.activeTaskCount(ct.dot_id) > 0) { mark(st,'skipped_busy'); continue; }
    deps.cp.ingestEvent({ source:'heartbeat',
      payload:{ goal: ct.prompt, title: ct.title, ctId: ct.id, dueAt: ct.next_fire },
      dedupKey: `hb:${ct.id}:${ct.next_fire}` });
    mark(st,'fired');
  }
}
```

- `catchup` 语义落在"先推进后投递"上：重启后错过的历史 `next_fire` 已不可见（列已更新），天然 = 'skip'；'latest' 模式如需补发，tick 检测到 `last_fired IS NULL 或距今 > 3*interval` 时对**当前** due 值补投一次——去重靠 dedup_key 含 `next_fire`，幂等安全。
- `skip_if_busy` 数据源（修复缺口⑬b）：`activeTaskCount = cp.list({status:['queued','running'], dotId}).length`（CP:471，O(index)），不引入未定义接口；`max_inflight` 由 dedup 天然覆盖（同一 due 时刻只会投一条事件），rev2 删除独立 `max_inflight` 字段。
- GOV 的 `expirePending/compactAudit` cron（GOV S6"注册进控制面统一调度器（心跳调度器同源）"）实现为：本 tick 循环注册外部 `jobs: Array<{ms, fn}>`，GOV/CP 向本模块注入回调——本模块提供 `registerIntervalJob(name, ms, fn)` 接口，自身不写业务。

### 5.5 Telegram bot（阶段二）

出站长轮询不变（`getUpdates timeout=25`，退避 1→60s，15min 连续失败仅告警不打死其他循环，`log` 通道上报）。rev2 修订两处：

- **崩溃恢复闭环（修复缺口⑦）**：offset 处理策略改为 **先持久化 offset、后处理消息**（写 `~/.dotd/telegram/offset.json` fsync 后再进处理函数）。窗口后果从"漏消息"换成"重拉同批 update"，安全性由 dedup_key=`tg:<update_id>` 交给 CP `events.dedup_key UNIQUE` 兜底（CP:179：重复投递返回旧 eventId，不重入管线）。审批指令消息不经事件表，幂等性由 GOV `decide()` 条件 UPDATE 天然保证（late 回复 → `{ok:false}` 记账不重复执行，GOV §3.3-3）。rev1 承诺的"update_id 幂等去重表"不再需要——锚在 CP，不双写。
- **入站分流**（不再全塞事件流）：文本先过 `looksLikeApprovalCommand(text)` 粗筛（`a\d+/d\d+/l/all` 及 reply 到审批消息）→ 命中则整体交 `gov.resolveTelegram(text, replyToMsgId)`（GOV S4：解析、寻址、规则求值全在 GOV）；未命中 → `ingest(source='telegram', dedupKey='tg:<update_id>', text)` → `cp.ingestEvent`。同 chat 3s debounce 合并只用于**非指令**消息（指令不可延迟）。
- 渲染：审批卡片正文 = `gov.renderTgNotice()` 生成（GOV S4，含 `#seq` 与 `a/d/ra/l` 指令语法，GOV §3.4）；本模块只做发送 + `surf_tg_card_state` 记录 message_id + `edit_throttle_ms` 节流；过期前 1h 提醒（GOV §3.4 由 GOV cron 触发 `approval:expiring` 或直接调 `notifyApprovalExpiring(id)`）→ 本模块 edit 卡片，**发前先查后写 `surf_tg_card_state.reminded_at`**，重启不重复提醒（修复缺口⑬a）。
- 按钮映射（GOV §3.5 词汇）：`✅ 批准一次=approve_once`、`🧠 批准并记住=approve_remember`（spend/dangerous 档在 TG 通道禁用——GOV:277 规则，本模块 UI 层同步隐藏按钮）、`❌ 拒=reject`。callback 并发由 GOV 先到先得规则吸收，本模块只把 `decide()` 返回值转成 toast。
- 其余指令：`/status`（cp.list + MR breaker + gov.listPending().length 渲染）、`/queue`、`/cancel <taskId>`（cp.cancel）、`/pause` `/resume`、`/sos-test`（调 §5.7 `deliver('telegram', …)` 自检）。
- 白名单外消息：静默 + `ingress_rejects(reason='allowlist')`。

### 5.6 CLI

`dotd serve|status|ask|approvals|approve|deny|watch|events|logs|task|cancel|hook|hb|sos-test`，全部经 `http://127.0.0.1:7788`（唯一监听，见 §2.1/Q0），token 顺序 `--token > DOTD_MASTER_TOKEN > ~/.dotd/cli_token`；daemon 不可达退码 7。`approve/deny` 调 `/api/approvals/:id/decision` 且只接受 `once|remember|reject` 词汇。CLI 不直写 SQLite。

### 5.7 通知通道适配器（`NotificationChannels`，供 MR 注入）

rev2 认领（修复缺口⑥，对齐 MR:724/678/591）：

```ts
// src/surfaces/channels.ts —— 由 daemon 装配层注入 ModelRouter.load({ channels })（MR:678）
export interface NotificationChannels {
  deliver(channel: 'telegram' | 'email', text: string): Promise<{ ok: boolean; error?: string }>;
  available(channel: 'telegram' | 'email'): boolean;   // MR §4.5 可用性判定：telegram = bot token 已配
                                                       // 且最近 5min getMe 成功；email = SMTP env 存在
}
```

- **属主划分**：求救的签名、去重、`alert_dispatch` 账本、`outbox` 兜底追加（写 `alerts.outbox_path`，MR:116 配置为准，阶段一即 `/dot/state/OUTBOX.md` 所在 daemon 状态目录）全在 MR；本模块**永不写 OUTBOX**、不做 24h 去重（避免双账本）。10s 超时由 MR 计时，本模块 `deliver` 内部对 Telegram 发送 3 次快重试（2s 间隔）后如实返回 `{ok:false}`。
- **email 通道认领**：本模块在阶段二实现 SMTP 适配器（`nodemailer`，纯 stdlib SMTP 亦可，凭据 `SMTP_URL` env）——填补"两模块都没认领"的空洞；阶段一 `available('email')=false`，与 MR:616"阶段一求救实际全走 OUTBOX"的既定路径一致。

---

## 6. 状态机（rev2：本模块不再自持状态机）

- **事件生命周期**：唯一权威 = CP `events.status`（pending→matched/ignored/inbox，CP:178）与恢复表（CP:438）。本模块只在 `ingress_rejects` 里记"从未成为事件"的失败，无中间态。
- **审批生命周期**：唯一权威 = GOV `approvals.status` 八态与迁移表（GOV §3.2 / :535-548；`pending→approved/rejected/expired`，`approved→executing/revoked`，`executing→executed/failed`，终态不可翻案——**裁决即终局**（GOV:214），rev1 的"expired 后主人回复转 decided 复活"作废，重做 = 新一次工具调用产生新审批单）。rev1 的 `deliver_state` 握手作废：卡片终态化信号直接取 GOV 状态——`executing`（"执行中"）→`executed/failed`（终态徽章）由 `approval:*` 事件驱动 Web 置灰与 TG edit（GOV §3.3-4、§8 事件表）。"第一条有效回复赢"由 GOV 条件 UPDATE 实现（GOV:237-243），本模块把 late 裁决的 `{ok:false, finalStatus, reason}` 原样转成 UI toast / TG edit 文案。
- **心跳**：`crontabs.enabled × surf_heartbeat_state.last_fire_status`，tick 循环见 §5.4。

---

## 7. Web UI 页面结构

同 rev1 骨架（聊天流/右侧栏 Queue+Breaker+Approvals/Events/Approvals 全量/Models/Logs/Settings），rev2 差异：

- 审批卡片按钮 = `approve_once / approve_remember（弹规则预览，GOV:315）/ reject`；dangerous 档需勾选"我确认不可逆"（GOV §3.5）；`tier` 徽章（read/write_file/browser/spend/dangerous）取代 rev1 的 low/medium/high（该枚举作废）。
- 卡片寻址、序号一律用 GOV 的 `seq` 与 `id`（GOV §3.4 `#seq`），rev1 自造 `AP-<base36>-<rand4>` ident 作废。
- 数据源声明：审批卡片字段全部来自 `ApprovalView`（GOV §3.5），页面**不自行判定状态合法性**（GOV S3）；步骤卡来自 `cp.getJournal(taskId)`/`GET /journal/:taskId`（CP §8/接缝6，UI 审批详情数据源 CP:511 既定）。
- SSE 断线重连：`Last-Event-ID = bus_seq`，超出重放窗 → `resync` + REST 快照校正（§4.5）。

---

## 8. 与其他模块的接缝（rev2 全部按对账修正）

**C1 · 控制面（CP）**
- 本模块只依赖 CP 已声明的接口：`ingestEvent`（唯一机器事件投递口，CP:485）、`submit/cancel/list/getJournal/getGuardStatus/onBus`（CP:461-492）。入站规范化产物类型 = CP `IngressEvent {source,payload,dedupKey}`，不新增顶层字段；业务扩展一律进 `payload`。
- `events` 表归 CP，本模块零写入（rev1 `event_log` 删除，杜绝双写）；UI 事件页读 CP 表。
- 心跳：调度事实列（cron/next_fire/enabled）读写 CP `crontabs`；行为扩展列在 `surf_heartbeat_state`，以 `ct_id` 外键关联——若仲裁认为扩展列应并入 `crontabs`，改动仅 §4/§5.4 两处。
- 单监听声明：全 daemon HTTP 只在 7788（§2.1），CP 的 REST 子集由本模块路由表转调实现。

**C2 · 治理（GOV）**
- 写：只有 `decide()` / `resolveTelegram()`（GOV §3.3/§3.4，S3/S4）。本模块及其 HTTP 端点、TG 适配、CLI 全是通道适配层，任何情况下不 UPDATE `approvals`。
- 读：`listPending()/ApprovalView`（GOV §3.5）+ `approval:created/decided/expired/claimed/revoked` 事件（GOV §8）。
- 时序：裁决 → `approval:decided` → 本模块 edit TG 卡片/置灰 Web 卡片 → GOV `claim()` → `approval:claimed` → `executed/failed` 事件 → 卡片终态。**不存在 deliver_state**（rev1 作废）。
- 词汇表（跨模块逐字一致，GOV S3）：`ApprovalStatus` 八态、`Verdict = approve_once|approve_remember|reject`、`tier` 五档、展示序号 `seq`。

**C3 · 模型路由（MR）**
- 本模块实现并注入 `NotificationChannels.deliver/available`（§5.7，MR:724 接口原文）；MR 持 `alert_dispatch` 账本与 OUTBOX；`router.mode_changed` 事件转 SSE `breaker` 通道供 UI 徽章/应急横幅。
- 阶段一 `channels=null`（MR:678）时本适配器不装配，接口形态已定（MR:616），阶段二插拔。

**C4 · 执行面**：零直连；步骤进度经 CP journal 读（§7）。审批引用 `approvals.journal_step TEXT == ToolCall.callId`（GOV:438/S1，CP steps.call_id ULID，CP:97/121）——本模块展示与崩溃重挂全部依赖该 TEXT 关联；rev1 `approval.step_id INTEGER` 作废（ULID 存不进 INTEGER，崩溃重挂承诺由此恢复）。

**C5 · 记忆**：无接口；`/api/conversations` 转调记忆模块会话 API，不读卷。

**C6 · 通用时序**：`ingestEvent` 同步部分（normalize+INSERT+规则匹配）<10ms，LLM 匹配异步（CP:485 decision 可 null，结果走事件）——SSE `event.received` 与 UI 事件页必须容忍"先 pending 后 matched"两段式；`surf_sse_cursor.seq` 单调、重启续读；所有循环共享同一 better-sqlite3 连接。

---

## 9. Windows/WSL 落地细节

同 rev1：portproxy 一行（`netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=7788 connectaddress=<WSL_IP> connectport=7788`），`dotd serve` 启动自检提示重跑；nice/亲和性运维注记不变。**磁盘留存**（本模块部分）：`surf_ingress_rejects` ≤5 万行、`surf_tg_card_state` ≤1 万行（每日随 GOV `compactAudit` 同期回调 purge）；`offset.json`、`*.errors.jsonl` 各 ≤10MB 滚动截断。

## 10. 分期对照

| 能力 | 阶段一 | 阶段二 | 阶段三 |
|---|---|---|---|
| Web UI 四视图 + CLI | ✅ | 事件/设置在线编辑 | 多 dot 切换 |
| HTTP webhook | ✅ | — | — |
| 心跳调度器 | ✅（interval+cron，crontabs 表） | scheduled turns 增强 | — |
| JSONL 监听 | 接口/表定型，默认关 | ✅ 默认开 | — |
| Telegram bot + 审批双通道 | ❌ | ✅ 全量 | 语音（CONTEXT:53 最后） |
| email 求救适配器 | ❌（available=false） | ✅（本模块认领，§5.7） | — |

## 11. 遵守的 CONTEXT 约束清单

1. TS 单进程 daemon + SQLite + Docker：本模块全部代码在 daemon 内，无 sidecar。
2. 完全自主：官方 Bot API 直连、零商业托管；Telegram 优先求救通道（CONTEXT:22）由 §5.7 落实。
3. Web UI 绑 127.0.0.1、localhost 转发访问（CONTEXT:34），不暴露公网。
4. 审批双通道承载于本模块，状态机与规则在治理（CONTEXT:19）。
5. 事件入口清单（HTTP/JSONL/心跳，邮件阶段二）全走 `ingestEvent`；heartbeat/event/target 三概念映射：event=CP `events`、target=CP `crontabs`、heartbeat=source 枚举。
6. 应急模式只展示不判定（状态源 MR，规则联动 GOV S5）。
7. 资源与磁盘约束显式（§2.2/§9）。
8. 崩溃安全（invisible_dots，CONTEXT:44）：offset 只停整行 + dedup_key 锚定 CP UNIQUE + 心跳先推进后投递 + TG 先持久化 offset——每层"可重放不重复执行"，重挂关联用 ULID `journal_step`（C4）。

---

## 12. 开放问题

- **Q0（新增，需仲裁）**：HTTP 监听属主——本模块主张全 daemon 唯一监听 7788、CP 的 REST 子集（CP:497 写 8642）转为本模块内部路由。若仲裁维持 8642 双服务，鉴权、CORS、SSE、CLI base URL 四处都要改，工期损失约 1 天。
- **Q1**：hooks/heartbeat 的 UI 写操作（POST/PUT/DELETE /api/hooks、/api/heartbeat）阶段一只留 CLI，UI 编辑推阶段二——维持。
- **Q3**：~~SSE id 命名空间~~ **已裁决于 §4.5**：独立 `bus_seq` 计数器 + resync 兜底；不再借用任何业务表主键。
- **Q4**：~~expired 复活~~ **作废**：以 GOV"裁决即终局"为准（GOV:214）；过期即失败改道，重做产生新审批单。若主人体验上需要"过期后一键重新发起"，属 CP 重新 submit 新任务，不属审批翻案。
- **Q5**：`chat.delta` 默认进 SSE 订阅集（UI 开关 `ui.stream_deltas`，阶段一实测后定默认值）。
- **Q6**：TG 非指令消息 debounce 3s 是否合适。
- **Q7**：/dot/home 记忆浏览页不进阶段一/二（维持）。
- **Q8**：多 dot 时 hooks/jsonl 的 `dot_id` 从单值到路由表——仍假设匹配逻辑全在 CP（`ingestEvent` 返回值已含 decision），本模块只透传配置里的默认 dot_id。
- **Q9（新增）**：`surf_heartbeat_state` 扩展列并入 CP `crontabs` 还是保留独立表（C1 已给单边改法，默认保留）。

---

## 13. 评审响应（逐条）

1. **审批表两属主**：接受。删除 rev1 §4.3 全量 DDL 与"字段属主"声明（原 surfaces.md:70）；`approvals` 以 GOV:432-470 为准——表名 `approvals`、八态 `ApprovalStatus`（GOV:535-543）、`Verdict=approve_once|approve_remember|reject`、展示序号 `seq`、`risk` 三档作废改用 `tier` 五档。§2.0 属主矩阵 + §6 状态机整节重写为"本模块不自持审批状态机，权威在 GOV"。
2. **deliver_state 无落点**：接受。握手整体删除（§6：rev1 该机制作废），卡片终态化信号改订阅 GOV `approval:claimed/executed/failed` 等事件（GOV §8 事件表），时序重写在 C2。
3. **唯一写路径/复活矛盾**：接受 GOV 版。`decide()` 是唯一写者（GOV:232），本模块 HTTP/TG/CLI 全降级为适配层（§5.5、C2）；`POST /api/approvals/:id/decision` 只是转调。expired 不可翻案（Q4 裁决关闭，rev1 §4.3 注释"过期后仍允许 answer"与 §6.2 expired→decided 边全部删除）。
4. **step_id 类型**：接受。INTEGER 列随整表删除；崩溃重挂改锚 `approvals.journal_step TEXT == ToolCall.callId`（ULID，GOV:438/S1 + CP steps.call_id:121），C4 明确"UI 展示与重挂依赖该 TEXT 关联"。
5. **事件表双写/id 冲突**：接受。`event_log`/`blobs` 表删除；机器事件唯一落处 = CP `events`（TEXT id + dedup UNIQUE，CP:177-186），投递统一 `cp.ingestEvent`（CP:485）；`tasks.source_event_id` 关联归 CP；本模块仅保留从未入管道的 `surf_ingress_rejects` 失败审计。TEXT id 不可作游标 → SSE 游标独立化（下条）。
6. **求救三方不一致**：接受 MR 接口原文。本模块实现 `NotificationChannels.deliver(channel,text)` + `available()`（§5.7，对齐 MR:724），`notifySOS` 命名作废；OUTBOX 写入归 MR、路径以 MR config `alerts.outbox_path` 为唯一来源，本模块不再声明 `~/.dotd/OUTBOX.md`；email 兜底空洞由本模块在阶段二认领实现（§5.7/§10，回答"谁实现"）。
7. **TG 幂等自相矛盾**：接受。不建 update_id 去重表；offset 改为**先持久化后处理**，at-least-once 的重复由 `dedup_key='tg:<update_id>'` 在 CP `events.dedup_key UNIQUE` 处吸收（§5.5 第一段，含崩溃窗口的逐情形说明）。
8. **JSONL 截断 dedup 冲突**：接受。dedup_key 加入 `gen`（§4 表 + `surf_jsonl_offset.gen` 列），inode 变化与截断重写两类旋转都 `gen++`，新内容行键不再撞旧行（§5.3）。
9. **Envelope.approvalReply 未覆盖**：接受且加码——Envelope 类型整体作废（rev1 虚构了 `enqueue(env)`），审批回复不进事件流：TG 走 `resolveTelegram()`（GOV S4）、Web/CLI 走 `decide()`；'answer' 词汇随 Verdict 枚举统一作废。§1 铁律表改为三分路径。
10. **JSONL 分期矛盾**：接受。§2.2 与 §10 统一为"阶段一接口/表定型、默认关，阶段二默认开"，删除"属阶段二"与"✅"两处互斥表述。
11. **priority 映射**：接受。字符串三档作废，§5.1 给出映射表（interactive=1 / heartbeat·hook=5 / bulk=7），并显式对齐 CP:277 淘汰规则（主人任务 priority=1 永不淘汰、file 批量最先淘汰）；CP 拒绝/淘汰时的 503 重投语义一并补上。
12. **SSE 借 event_log.id 不可实现**：接受。独立 `bus_seq` 计数器（`surf_sse_cursor` 持久化、重启续读）+ 超窗 `resync` + REST 快照校正（§4.5），"借 id"措辞全部清除，Q3 关闭。
13. **两个小缺口**：① 提醒已发标记落 `surf_tg_card_state.reminded_at`（发前查后写，重启不重复）；② `inflightOfKind` 删除，`skip_if_busy` 数据源定义为 `cp.list({status:['queued','running'],dotId}).length`（CP:471），心跳自身并发由 dedup_key（含 due 时刻）天然封顶（§5.4）。
14. **过关项**：知悉，rev2 未改动 CONTEXT 对照结论（§11 保留并补第 8 条崩溃安全落点）。

另有一处评审未点名、对账中发现的冲突已一并处理：CP 自述 HTTP 监听 8642（CP:459/497）与本模块 7788 双端口问题——本模块主张唯一监听 7788、CP REST 转内部路由，冲突上报为 Q0 仲裁，未擅改 CP 文件。
