# 模块详设：模型路由与容灾（ModelRouter）— rev2

> 依据：`dotd-design/CONTEXT.md`（下称 CONTEXT）。本文不推翻 CONTEXT 的任何技术选型：TypeScript 单进程 daemon（Node 24）+ SQLite（better-sqlite3，单写者）+ WSL 内运行；模型 API 是唯一外部依赖，`base_url` 可热切换。
> rev2：根据评审 17 条缺口逐条修订，对应关系见文末「评审响应」。
> 机器事实引用：本地 Colibrì 无 batching（`max_kv_slots=1`，并发只排队，实测 concur=8 时聚合吞吐 4.52 tok/s、延迟 32s，来源：项目记忆 `colibri-no-batching.md`）；`:8001` OLMoE 启动后 `/health` 约 1.8GB 时即响应但全量驻留需约 2 分钟，warm 判据为 `GET /profile` **末条 turn** 的 `expert_disk_s` 不超过阈值（2026-10-17 修订：原判据写 `== 0.00` 且只比顶层键，而 Colibrì 把该字段嵌在 `turns[]` 里，导致宽限期外永远判不 warm、tier2 降级链实际断裂；实测冷启动序列 10.0/1.0/0.9/0.47s、驻留后 0.02s 以下，故改阈值分界）（来源：`colibri-local-deployment.md`、`dotd-full-test-2026-10-17.md`）；github.com / huggingface.co 直连超时，可用 `api.github.com`、`hf-mirror.com`（来源：`network-blocked-github-huggingface.md`）——侦察模块的取源路径必须绕开前者。

---

## 1. 模块职责与边界

### 1.1 职责（做什么）

1. **多级降级路由**：按 CONTEXT 的阶梯组织候选端点：
   - Tier 1（配置内主模型，OpenRouter 等可热切换 `base_url`）
   - Tier 2（本地引擎：Colibrì :8001 / Ollama，尽力而为）
   - Tier 3（策展免费池 `free-models.yml`，需通过微型工具调用往返测试才可用于主循环）
   - Tier 4（互联网侦察候选——**只侦察、只提案，接入必须主人批准**）
2. **熔断器**：按端点×角色（primary/light）维护 closed/open/half_open 状态，失败分类（429/5xx/超时/网络/鉴权/协议错误），指数退避半开探活，**状态持久化到 SQLite**，daemon 重启不丢。
3. **双轨路由**：按事件类型区分主循环调用（`primary`，要求工具调用质量）与低智能高频调用（`light`，可落本地）。
4. **应急模式判定**：当前服务档位（mode）的计算与广播；Tier ≥ 3 服务时置 `emergencyActive`，供治理/队列收缩任务范围（低危可跑、浏览器登录态操作强制转审批）。
5. **免费池健康维护**：定期 health check + 微型工具调用往返测试，结果写库并驱动熔断与"可用资格"。
6. **求救与恢复通报**：通道优先级 Telegram → email → `OUTBOX.md`；同一故障签名 24h 去重；恢复时发通报。
7. **侦察调度**：非 NORMAL 期间定时侦察候选（读元数据，不发推理请求），产出提案并附在求救消息里。
8. **调用记账**：每次路由调用记录到 `model_call_log`（供 Web UI 状态页与事后审计）。

### 1.2 边界（不做什么）

- 不管理任务队列、不决定重试业务语义（任务级重试由控制面/队列模块做，路由只暴露 `attemptId` 供其 journal 幂等关联）。
- 不做审批决策：应急模式的"转审批"、侦察候选的"批准接入"都由治理/审批模块裁决，路由只**发起请求**（事件）并**消费结果**（回调）。
- 不直接持有 Telegram/SMTP 的连接实现：求救消息交给"通知通道模块"（阶段二）投递；阶段一无 Telegram/邮件时路由**直接落 OUTBOX.md**（自己实现文件追加即可）。
- 不管理本地引擎的启动/停止（Colibrì/Ollama 进程生命周期属于执行面/运维脚本），只探测可用性并据结果路由或降级。
- 不做向量检索、不做上下文压缩（属于记忆模块；路由只透传请求体）。

---

## 2. 配置与数据契约（配置文件）

路由的可变配置全部在两个 YAML 里，"换供应商改一行配置"由 `models.yml` 的 `base_url` 热切换兑现（文件监听器 + `/v1/admin/reload`）。

### 2.1 `config/models.yml`

```yaml
# 端点定义。tier: 1|2。tier3 来自 free_models_file，tier4 来自 recon_candidate 表。
version: 1
reload_debounce_ms: 1500

endpoints:
  - id: openrouter-main
    tier: 1
    base_url: https://openrouter.ai/api/v1   # ← 换供应商只改这一行 + key_env
    api_key_env: OPENROUTER_API_KEY
    models:
      primary: anthropic/claude-sonnet-4.5    # 主循环
      light:   google/gemini-2.5-flash        # 低智能分流（云端兜底）
    style: openai
    timeouts: { connect_ms: 5000, idle_ms: 60000, total_ms: 180000 }
    emergency_eligible: true                  # 应急模式下仍可用（付费自有通道）。执行语义见 §4.2：应急档位下承载 primary 的硬门槛

  - id: backup-openai-compatible
    tier: 1
    base_url: https://api.xxx.example/v1
    api_key_env: BACKUP_API_KEY
    models: { primary: some/model, light: some/model-mini }
    style: openai
    enabled: false                            # 备胎默认关，主人启用即热生效
    emergency_eligible: true

  - id: colibri-olmoe
    tier: 2
    base_url: ${DOTD_TIER2_HOST:-http://127.0.0.1:18001}/v1
    models: { light: olmoe-colibri }   # 7B 无（已证实的）工具调用能力，默认只挂 light；主人显式加 primary 行即授权降格（§4.3）
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 15000, total_ms: 45000 }
    local:                                    # queue_reject_ms 等参数一律挂在端点.local 下；调用方不得覆盖（§4.2）
      health_url: ${DOTD_TIER2_HOST:-http://127.0.0.1:18001}/health
      warm_check:
        url: ${DOTD_TIER2_HOST:-http://127.0.0.1:18001}/profile
        json_max: { 'turns.last.expert_disk_s': 0.1 }
      warm_grace_ms: 150000                   # /health 通过≠全量驻留，宽限期外不判 warm
      max_concurrency: 1                      # 无 batching 实测结论：并发只排队，超 1 直接快速失败
      queue_reject_ms: 8000                   # 槽位被占超 8s → 本请求放弃该端点（是否入窗见 §4.1 busy 规则）
  - id: ollama
    tier: 2
    base_url: http://127.0.0.1:11434/v1
    models: { light: qwen2.5:7b }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 15000, total_ms: 45000 }
    local: { health_url: http://127.0.0.1:11434/api/tags, max_concurrency: 2, queue_reject_ms: 8000 }

free_models_file: config/free-models.yml

routing:
  default_track: primary
  light_events:                               # 事件类型 → light 轨（前缀匹配）
    - event.classify
    - event.route
    - event.match               # 事件→目标匹配的置信度打分
    - memory.summarize
    - heartbeat.triage
    - queue.dedupe
    - digest

breaker:
  window_size: 20          # 滑动窗口样本数
  window_ms: 300000        # 窗口时限 5min
  min_samples: 5           # 判失败率所需最少样本
  failure_ratio: 0.5       # open 阈值
  consec_failures: 3       # 连续失败直接 open（不等窗口）
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000  # 429 Retry-After 软冷却上限，超过则按 open 处理
  busy_consec_limit: 3     # Tier2 槽位连续 queue_reject 达到该数 → 按 engine_unavailable 入窗（§4.1）

alerts:
  dedup_window_ms: 86400000          # 同一签名 24h 只求救一次
  outbox_path: /dot/state/OUTBOX.md  # 兜底通道（daemon 侧状态目录，非容器卷）
  channel_order: [feishu, telegram, email, outbox]   # 2026-10-16 主人拍板飞书首位；TG/email 未装配时 available=false 自动跳过
  channel_timeout_ms: 10000          # 单通道投递超时即换下一通道

recon:
  interval_ms: 21600000              # 非 NORMAL 时每 6h 侦察一次
  max_candidates_per_scan: 10
  sources:
    - type: openrouter_models        # GET https://openrouter.ai/api/v1/models（元数据，非推理）
      filter: ":free"
    - type: github_curated           # 经 api.github.com contents/ 取策展清单更新（github.com 直连被墙）
      api_url: https://api.github.com/repos/{owner}/{repo}/contents/free-models.yml
      raw_via: base64
  candidate_ttl_ms: 604800000        # 提案 7 天无人理会 → expired；再次扫到按 §4.6 复活规则处理
  rejected_cooldown_ms: 2592000000   # 被拒候选 30 天内不再重复提案
```

### 2.2 `config/free-models.yml`（Tier 3 策展池）

```yaml
version: 1
updated_at: 2026-10-14T00:00:00Z
models:
  - id: groq-llama-free
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY          # none/无 env 名 = 免鉴权端点
    models: [llama-3.3-70b-versatile]
    style: openai
    capabilities: { tool_calling: unknown, context: 128000 }
    rate: { rpm: 30, rpd: 1000 }
    last_verified: null                # 微型工具调用往返测试通过时间；null=从未通过
    verify_staleness_ms: 86400000      # 通过结果 24h 过期，需复测
    emergency_eligible: true           # 池内条目默认 true——池本身就是应急档
```

> 说明：池内条目的 `capabilities.tool_calling` 允许写 `unknown`——首次被选为 primary 候选前，路由**按需现测**（见 §4.4），测过才可用。这是"策展"与"实时性"的折中：不信任清单上的静态声明。

---

## 3. 核心数据结构与表设计

### 3.1 TypeScript 类型（`src/router/types.ts`）

```ts
export type Track = 'primary' | 'light';                 // 双轨
export type Tier = 1 | 2 | 3 | 4;
export type BreakerState = 'closed' | 'open' | 'half_open';
export type FailureKind =
  | 'rate_limit'      // 429（含 quota 文案细分见 quota）
  | 'quota'           // 402 / 429 body 含 quota/credits → 长期不可用，backoff 起步 30min
  | 'server_error'    // 5xx
  | 'timeout'         // 连接后无响应 / idle 超时
  | 'network'         // DNS/拒连/断流
  | 'auth'            // 401/403 → 配置或 key 问题
  | 'bad_protocol'    // 非 JSON、缺 choices、工具调用格式非法等
  | 'engine_unavailable'   // 仅 Tier2 本地端点：health/warm 探测不过，或槽位连续 busy 达 busy_consec_limit（§4.1）
  | 'pool_unverified';     // 仅 Tier3 池端点：/models 健康探测失败（常规 backoff 起步 60s，不占 engine_unavailable 语义）

export interface EndpointDef {
  id: string; tier: Tier; baseUrl: string; apiKeyEnv: string | null;
  models: Partial<Record<Track, string>>;    // 该端点各轨用的模型名
  style: 'openai';
  enabled: boolean;
  timeouts: { connect_ms: number; idle_ms: number; total_ms: number };
  emergencyEligible: boolean;                // 应急档位下能否承载 primary（执行点唯一在 §4.2 pickCandidates）
  local?: { health_url: string;
            warm_check?: { url: string;
                           json_eq?: Record<string, number>;   // 逐键相等；键为点分路径（数字段索引数组，last 取末元素）
                           json_max?: Record<string, number> }; // 逐键"不超过阈值"；路径语义同上
            warm_grace_ms?: number; max_concurrency: number; queue_reject_ms: number };
  capabilities?: { tool_calling: 'yes' | 'no' | 'unknown'; context: number };
  rate?: { rpm: number; rpd: number };
  lastVerifiedAt?: number;                   // Tier3 专用：工具往返测试通过时刻
  // 注：EndpointDef 是纯配置值对象，不含运行时字段。Tier2 的内存槽位信号量与连续 busy 计数
  // 存在 RouterRuntime 里，按端点 id 索引，与配置对象分离。
}

// 运行时状态与配置分离（config reload 时重建语义见 §4.7）
interface RouterRuntime {
  slots: Map<string, { sem: Semaphore; busyConsec: number }>;  // 仅 Tier2；sem 容量=local.max_concurrency
}

export type RouterMode =
  | 'NORMAL'          // tier1 端点可服务（primary 轨）
  | 'LOCAL_FALLBACK'  // 仅 tier2 可服务：light 正常，primary 视情况（见 §4.3）
  | 'EMERGENCY'       // tier3 池承载中，任务范围收缩生效
  | 'RESTRICTED'      // 只剩不合格模型/全挂：primary 停摆，light 尽量，任务挂起
  | 'TOTAL_OUTAGE';   // 无任何可服务端点

export interface RouteRequest {
  track: Track;
  messages: ChatMessage[];
  tools?: ToolSpec[];             // primary 轨必带
  tool_choice?: 'auto' | 'required' | string;
  maxTokens?: number; temperature?: number;
  eventId?: string;
  attemptId: string;              // = journal 步骤 id，调用方生成，重试时不变
  deadlineMs?: number;            // 整次路由（含所有候选切换）的总预算；缺省按轨取默认（§4.2 预算规则）
  stream?: boolean;               // true 则走 stream()（§4.7）
  signal?: AbortSignal;
  // 注意：attemptSeq 不是入参——由路由在单次 route 调用内从 0 自增，随 RouteMeta 回传（§4.2、§6.2）。
  // 端点级参数（queue_reject_ms 等）一律来自配置，RouteRequest 不提供覆盖字段。
}

export interface RouteMeta {
  endpointId: string; tier: Tier; model: string;
  degraded: boolean;              // true = 非标准档位承载 primary（tier2 显式授权降格 / tier3/4 池与侦察），供审查模块加验（§4.3、§6.3）
  attemptSeq: number;             // 本次调用消耗前的自增计数（route 调用内 0..N-1）
  tried: TryRecord[];             // 到 meta resolve 时刻为止的尝试序列
  streamStarted: boolean;         // 首字节是否已下发给调用方（§4.8）
}

export interface RouteResult {
  meta: RouteMeta;
  response: ChatResponse | AsyncIterable<ChatChunk>;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface RouterSnapshot {   // Web UI / CLI `dotd models status` 消费
  mode: RouterMode; emergencyActive: boolean;
  endpoints: Array<{ id: string; tier: Tier; emergencyEligible: boolean;
    roles: Record<Track, { breaker: BreakerState; consecFailures: number; nextProbeAt: number | null;
    throttledUntil: number | null; lastKind: FailureKind | null }> }>;
  pool: Array<{ id: string; lastVerifiedAt: number | null; qualifiedForPrimary: boolean }>;
  pendingRecon: number;            // needs_approval 候选数
  openAlerts: number;              // resolved_at IS NULL 的 help 行数
  lastAlert: { signature: string; sentAt: number; channel: string } | null;
}

export type RouterEvent =
  | { type: 'mode_changed'; from: RouterMode; to: RouterMode; at: number }
  | { type: 'breaker_changed'; endpointId: string; track: Track; from: BreakerState; to: BreakerState }
  | { type: 'recon_proposal'; candidateId: string; summary: string }   // 治理/审批模块订阅
  | { type: 'help_needed'; signature: string; urgent: boolean };       // 通知通道模块订阅
```

### 3.2 SQLite DDL（`db/migrations/010_model_router.sql`）

```sql
-- 熔断器持久状态：端点 × 角色 一行。daemon 重启后原样恢复。
CREATE TABLE IF NOT EXISTS breaker_state (
  endpoint_id     TEXT    NOT NULL,
  track           TEXT    NOT NULL CHECK (track IN ('primary','light')),
  state           TEXT    NOT NULL DEFAULT 'closed'
                  CHECK (state IN ('closed','open','half_open')),
  opened_at       INTEGER,                      -- epoch ms
  next_probe_at   INTEGER,                      -- open 到期后半开探活时刻
  backoff_ms      INTEGER NOT NULL DEFAULT 60000,
  consec_failures INTEGER NOT NULL DEFAULT 0,
  half_open_ok    INTEGER NOT NULL DEFAULT 0,   -- 连续探活成功数（>=2 转 closed）
  throttled_until INTEGER,                      -- 429 软冷却（state 仍 closed，选取时跳过）
  last_kind       TEXT,                         -- FailureKind
  last_error      TEXT,                         -- 截断到 500 字符的原始错误
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (endpoint_id, track)
);

-- 滑动窗口样本（短命数据，随用随删；与 breaker_state 分开是因为窗口是环形明细）
CREATE TABLE IF NOT EXISTS breaker_sample (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT    NOT NULL,
  track       TEXT    NOT NULL,
  ok          INTEGER NOT NULL CHECK (ok IN (0,1)),
  kind        TEXT,                             -- 失败时的 FailureKind；busy 型样本记 'engine_unavailable'
  latency_ms  INTEGER,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bsample ON breaker_sample(endpoint_id, track, ts);

-- 状态迁移审计（Web UI 时间线 + 事后复盘；90 天回收）
CREATE TABLE IF NOT EXISTS breaker_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT    NOT NULL,
  track       TEXT    NOT NULL,
  from_state  TEXT    NOT NULL,
  to_state    TEXT    NOT NULL,
  reason      TEXT,                             -- 人读原因，如 "5xx 3连败" / "quota" / "本地槽位连续busy"
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bevent_ts ON breaker_event(ts);

-- 全局单行式路由状态（mode、emergency_active、当前主服务等）
CREATE TABLE IF NOT EXISTS router_state (
  key        TEXT PRIMARY KEY CHECK (key IN ('mode','emergency_active','primary_endpoint_id','mode_since')),
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Tier3 池探测结果（health + 微型工具往返测试）。只留每端点最新 + 7 天历史。
CREATE TABLE IF NOT EXISTS pool_probe_result (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id   TEXT    NOT NULL,
  probe_kind    TEXT    NOT NULL CHECK (probe_kind IN ('health','tool_roundtrip')),
  ok            INTEGER NOT NULL CHECK (ok IN (0,1)),
  detail        TEXT,                           -- JSON: {latency_ms, tool_name, args_valid, rounds}
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_ep ON pool_probe_result(endpoint_id, ts);

-- Tier4 侦察候选。状态机（§4.6）：
--   needs_approval → approved | rejected
--   approved → live | expired        live → retired（主人从池文件移除该条目时回写）
--   expired → needs_approval         retired → needs_approval   （再次扫到时复活重提案，见 §4.6 去重规则）
--   rejected：30 天冷却期内不再出现在任何扫描结果
CREATE TABLE IF NOT EXISTS recon_candidate (
  id            TEXT PRIMARY KEY,               -- 'recon:' + sha1(source|base_url|model) 前 12 位
  source        TEXT NOT NULL,                  -- openrouter_models | github_curated | manual
  base_url      TEXT NOT NULL,
  model         TEXT NOT NULL,
  api_key_note  TEXT,                           -- 需要什么凭证，绝不存 key 本身
  rate_note     TEXT,
  evidence      TEXT,                           -- JSON: 来源 URL、抓取时间、宣称参数
  state         TEXT NOT NULL DEFAULT 'needs_approval'
                CHECK (state IN ('needs_approval','approved','rejected','live','expired','retired')),
  decided_by    TEXT,                           -- 'owner'（审批模块回写）
  decided_at    INTEGER,
  reject_reason TEXT,
  found_at      INTEGER NOT NULL,               -- 每次(重新)进入 needs_approval 时刷新；expired 判定的基准
  updated_at    INTEGER NOT NULL,
  UNIQUE(base_url, model)
);

-- 求救去重 + 通报记录。signature = sha256(newMode + 排序后的失败端点及 kind + tier)，
-- 签名相同 = 同一事件，24h 只求救一次。
-- 写入协议（§4.5）：投递前先 INSERT（delivered_via='pending'），投递结果回写；
-- 崩溃恢复时对 pending 超 2min 的行补投或标 'lost'——去重账本永远不丢已发事件。
CREATE TABLE IF NOT EXISTS alert_dispatch (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  signature    TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('help','recovery','recon_proposal')),
  mode         TEXT    NOT NULL,
  failing_json TEXT    NOT NULL,               -- [{endpoint_id, track, kind, consec}]
  served_by    TEXT,                           -- 当前实际服务端点 id 或 'none'
  task_impact  TEXT,                           -- JSON: {queued_primary, running, held}，来自队列 provider（§6.2）
  channels_tried TEXT NOT NULL,                -- JSON: [{channel:'telegram',result:'timeout'},...]
  delivered_via TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'telegram'|'email'|'outbox'|'none'|'lost'
  sent_at      INTEGER NOT NULL,               -- 意图登记时刻（非投递成功时刻）
  delivered_at INTEGER,                        -- 实际投递成功时刻，NULL=未成
  resolved_at  INTEGER                         -- 被恢复通报覆盖时回写（可多行，见 §4.5 恢复收敛）
);
CREATE INDEX IF NOT EXISTS idx_alert_sig ON alert_dispatch(signature, resolved_at);

-- 路由调用记账（供 UI/审计/journal 对账；30 天或 20 万行上限）
CREATE TABLE IF NOT EXISTS model_call_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id   TEXT NOT NULL,                   -- journal 步骤 id，重试不变
  attempt_seq  INTEGER NOT NULL,                -- 路由本次 route 调用自增后回写（§4.2）
  event_id     TEXT,
  track        TEXT NOT NULL,
  endpoint_id  TEXT NOT NULL,
  model        TEXT NOT NULL,
  degraded     INTEGER NOT NULL DEFAULT 0,      -- 1 = 非标准档位承载 primary（§4.3 审查加验依据，与 RouteMeta.degraded 同源）
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','fail','breaker_skip','throttle_skip','half_open_busy_skip','stream_broken')),
  kind         TEXT,                            -- 失败 FailureKind；本地槽位 busy 记 'engine_unavailable'
  latency_ms   INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_attempt ON model_call_log(attempt_id);
CREATE INDEX IF NOT EXISTS idx_call_ts ON model_call_log(ts);
```

**体积与回收（贴合 CONTEXT "C:/D: 盘不大" 约束）**：
`breaker_sample` 每端点×角色只留最近 `window_size` 条（写入时 `DELETE … WHERE ts < now-window_ms` + `TRIM` 到 20）；`model_call_log` 每晚 `DELETE WHERE ts < now-30d` 且 `COUNT>200000` 时截老；`breaker_event` 90 天；`pool_probe_result` 每端点保留最新 1 条 + 7 天内历史；`recon_candidate` 的 `expired/retired` 行保留 90 天后物理删除。以上由路由自带的 janitor（心跳调度器注册 `router.janitor` light 任务）执行，估算总量 < 50 MB。

---

## 4. 关键流程与状态机

### 4.1 熔断器状态机（每 endpoint×track 一个实例）

```
            失败率≥0.5(窗口≥5样本) 或 连续失败≥3 或 auth/quota(立即)
  closed ────────────────────────────────────────────────▶ open
    ▲                                                       │ next_probe_at 到期
    │  half_open_ok ≥ 2                                      ▼
    └──────────────── half_open ◀─────────── 放行 1 个探活请求（最长 15s）
                            │ 任一失败
                            ▼
                     open（backoff ×2，上限 1h；quota 类起步 30min）
```

分类与记账规则（`classifyError(err): FailureKind`）：

| 信号 | kind | 对 breaker 的影响 |
|---|---|---|
| HTTP 429，body 无 quota 文案，`Retry-After ≤ 120s` | rate_limit | **不 open**，写 `throttled_until=now+Retry-After`；窗口记 ok（不是故障） |
| HTTP 429 含 quota/credits/balance，或 402 | quota | 立即 open，backoff 起步 30min，仍按 60min 上限翻倍 |
| HTTP 401/403 | auth | 立即 open + reason="鉴权失败"；**不自动恢复**——半开只允许在配置 reload 事件后触发（防止烧探活额度） |
| HTTP 5xx | server_error | 正常计入窗口 |
| connect/idle/total 超时 | timeout | 正常计入窗口 |
| DNS/ECONNREFUSED/ECONNRESET/断流 | network | 正常计入窗口 |
| 响应 200 但非 JSON / 缺 choices / tool_call 参数不是合法 JSON | bad_protocol | 计入窗口；对 primary 轨额外把 `capabilities.tool_calling` 记为 `no`（本会话内不再选它做 primary） |
| Tier2：health/warm 探测不过 | engine_unavailable | 计入 light 轨窗口，backoff 起步即 5min（本地引擎挂了不会秒好） |
| Tier2：槽位获取超时（queue_reject_ms 内没拿到） | 不直接入窗 | busy 计数器 `busyConsec+1`；**未达 `busy_consec_limit`(3) 时只跳过该端点**（排队不是故障，且此刻已有请求正在它上面成功服务，判它失败自相矛盾）；**连续达到 3 → 记一次 `engine_unavailable` 入窗并按 engine 类退避（起步 5min）**——这保证 Colibrì"长期半死不活"（CONTEXT:36 内存吃紧场景）必然触发降级与 mode 重算，而非窗口永远健康。任一成功获取槽位的调用把 `busyConsec` 清零 |
| Tier3：池 `/models` 健康探测失败 | pool_unverified | 常规窗口样本（backoff 起步 60s）。不借用 engine_unavailable 的 5min 起步——那是本地引擎语义 |

半开探活请求的选择：**优先夹带真实流量**——half_open 时第一个到达的该端点请求即探活（成功则计入 `half_open_ok`）；无真实流量时由心跳定时器 `probe:${endpoint}` 合成一个最小请求（light 轨发 8-token 的 "ping"，primary 轨**不发合成探活**——工具调用质量无法用 ping 验，只靠真实流量或池测试恢复）。

**half_open 并发裁决（补 rev1 缺口）**：`half_open_max_concurrency=1`，运行时一个端点×角色同时只允许 1 个在途探活请求。第 2..N 个并发请求对该端点一律按 open 对待——`tried.push(ep,'half_open_busy_skip')` 后继续走下一候选（不等待、不入窗、不改状态）。理由：并发打满探活会一次性烧光半开机会。端点轮完仍全被 busy/open 挡住时，按 §4.2 走 `AllEndpointsDownError` 路径——但注意 half_open_busy 不计入 tried 的失败语义，队列照常挂起等待。真实流量到达时刻即计时 `probe:${endpoint}` 暂停（探活已由真实请求承担）。

### 4.2 请求主流程（`route()`，非流式；流式见 §4.7/§4.8）

```ts
async function route(req: RouteRequest): Promise<RouteResult> {
  // 预算规则（补 rev1 缺口 5）：
  //   总预算 = req.deadlineMs ?? 轨默认（primary 300s / light 60s）。
  //   默认 300s ≥ 单端点最大 total_ms(180s) + 其余候选快速尝试（tier2 各 ~16s + tier3 测试/调用），
  //   使「单圈扫描」在默认配置下算术上可行；tier1 多端点时主人应显式收紧各端点 total_ms。
  //   单候选可用预算：cap = min(ep.timeouts.total_ms, max(remaining/2, MIN_USEFUL_MS))。
  //   remaining < MIN_USEFUL_MS(5000) 才 break —— 候选数不设硬上限，预算耗尽自然止损。
  const deadline = req.deadlineMs ?? (req.track === 'primary' ? 300_000 : 60_000);
  let attemptSeq = 0;                                   // 路由本次调用内自增；跨 route 调用不持久（§6.2 journal 对账以 attemptId 聚合）
  const tried: TryRecord[] = [];
  for (const ep of pickCandidates(req)) {
    if (req.signal?.aborted || remaining(deadline) < MIN_USEFUL_MS) break;
    const b = breakers.get(ep.id, req.track);
    if (b.state === 'open')       { tried.push(ep, 'breaker_skip');    continue; }
    if (b.state === 'half_open' && !b.halfOpenSlot.tryAcquire())
                                  { tried.push(ep, 'half_open_busy_skip'); continue; }  // §4.1 并发裁决
    if (b.throttledUntil > now()) { tried.push(ep, 'throttle_skip');   continue; }
    if (ep.tier === 3 && req.track === 'primary') {
      const q = await ensureToolQualified(ep, deadline);            // §4.4；不过则记录并继续
      if (!q.ok) { tried.push(ep, 'pool_unverified'); b.recordFailure('pool_unverified'); continue; }
    }
    const cap = Math.min(ep.timeouts.total_ms, Math.max(remaining(deadline) / 2, MIN_USEFUL_MS));
    if (ep.tier === 2) {
      if (!(await localGate(ep, 2000))) {                             // health+warm 两道闸，2s 预算
        tried.push(ep, 'engine_unavailable'); b.recordFailure(ep.track, 'engine_unavailable'); continue;
      }
      const slot = await runtime.slots.get(ep.id).sem
        .tryAcquire(ep.local.queue_reject_ms);                        // 参数只来自端点配置（无请求级覆盖）
      if (!slot) {                                                    // busy 规则见 §4.1：不直接入窗，连续达 3 才记 engine_unavailable
        const nowBusy = runtime.slots.get(ep.id).bumpBusy();
        tried.push(ep, 'engine_unavailable');
        if (nowBusy >= breakerCfg.busy_consec_limit) b.recordFailure(ep.track, 'engine_unavailable');
        continue;
      }
      try { return await callAndSettle(ep, req, slot, b, attemptSeq++); } finally { slot.release(); }
    }
    try {
      return await callAndSettle(ep, req, null, b, attemptSeq++);    // closed 清零；half_open 下 half_open_ok++
    } catch (err) {
      const kind = classifyError(err);
      tried.push(ep, kind); b.recordFailure(kind);
      if (kind === 'auth') enqueueHelpSoon();                          // 鉴权故障 = 需要人，进求救判定队列（§4.5 节流）
      continue;                                                        // 一切失败都换下一候选
    }
  }
  throw buildExhaustedError(tried, req.track);       // 三选一，见下
}

// 循环耗尽时的错误裁决（补 rev1 缺口 13）：
function buildExhaustedError(tried, track) {
  const kinds = tried.map(t => t.failure);
  if (track === 'primary' &&
      kinds.some(k => k === 'pool_unverified') &&
      !kinds.some(k => ['server_error','timeout','network','quota','auth','engine_unavailable','rate_limit'].includes(k)) &&
      reconNeedsApprovalCount() > 0) {
    return new NoQualifiedPrimaryError(tried);       // 唯一抛出点：候选里有池端点但都被工具合格证挡下，且存在待批侦察候选
  }
  if (track === 'primary' &&
      kinds.every(k => k === 'breaker_skip' || k === 'throttle_skip' || k === 'half_open_busy_skip') &&
      db.countOpenHelp() > 0) {
    return new AllEndpointsDownError(tried, helpAlreadyOpen=true);   // §4.5：不重复求救，队列仍挂 waiting_model
  }
  return new AllEndpointsDownError(tried);
}

function pickCandidates(req: RouteRequest): EndpointDef[] {
  const list = endpoints.filter(e => e.enabled && e.models[req.track]);
  // emergencyEligible 的【唯一执行位点】（补 rev1 缺口 1，兑现 CONTEXT:29「应急模式自动收缩」）：
  //   mode ∈ {EMERGENCY, RESTRICTED, TOTAL_OUTAGE}（即服务已落到 tier3 及更差）且 track === 'primary'
  //     → 过滤掉 emergencyEligible=false 的端点（非 eligible 的付费/试用通道在烧钱档不承担主循环）。
  //   LOCAL_FALLBACK 不过滤：本地是免费兜底档，不属于收缩范畴。
  //   light 轨永不受该字段影响（收缩的是主循环业务面，不是低智能调度）。
  //   被过滤端点不写 tried——它不是"试过失败"，而是"档位不允许"。
  if (emergencyGateActive() && req.track === 'primary') {
    return list.filter(e => e.emergencyEligible).sort(byTierThenOrder);
  }
  return list.sort(byTierThenOrder);
  // 轨内排序：tier 升序；同 tier 按 models.yml 声明顺序（主人钦定优先级）；
  // Tier3 内部：lastVerifiedAt 新者先，rpd 剩余额度未知的排后。
}
```

要点：
- **失败永远向前降级，绝不向上涨档重试**（tier1→2→3→4 单向扫描，一次请求最多走一圈）。一圈的算术可行性由默认总预算 300s 与各候选 `remaining/2` 切分保证（见上注释）。
- Tier2 并发上限硬编码为配置值（Colibrì `max_concurrency: 1`），这是机器实测结论（无 batching、并发只排队）的直接落地：宁可跳过降级，不可让 8 个请求在本地引擎排队各自超时。端点级参数（`queue_reject_ms`）只来自 `endpoint.local`，`RouteRequest` 无覆盖通道。
- `AllEndpointsDownError` / `NoQualifiedPrimaryError` 都不是终点——队列模块收到后把任务标记 `waiting_model` 挂起，mode 恢复时自动续跑（见 §6 接缝）；后者额外要求 help 消息附上"待批侦察候选"段。

### 4.3 Router mode 状态机（全局单实例，持久化于 `router_state`）

```
mode = 能服务 primary 轨的最高档（最小 tier）；无 primary 能力但 light 可用 → RESTRICTED；
       全不可用 → TOTAL_OUTAGE。tier1 有任一（emergencyEligible 过滤后仍）可服务端点 → NORMAL，以此类推。

 NORMAL ◀──────────────────┐ 任一 tier1 endpoint×primary 恢复 closed
   │ 全部 tier1 primary open │
   ▼                        │
 LOCAL_FALLBACK ── tier2 light 可用（primary 挂起或降格，见下）
   │ tier2 也不可用          │
   ▼                        │
 EMERGENCY（tier3 承载；emergencyActive=true）──┐
   │ 无 tool-qualified 池模型 │                   │ light 仍可用则
   ▼                                           ▼
 RESTRICTED（primary 停摆，light 尽力，emergencyActive=true）
   │ 全挂
   ▼
 TOTAL_OUTAGE ──▶ 每 6h 侦察 + 每 6h 真实重试（primary 挂起任务逐个试探）
```

- **LOCAL_FALLBACK 时 primary 轨的策略**：OLMoE 7B 被 CONTEXT 明言"撑不起主循环"，因此 primary 请求在此档位默认**不入本地**，而是 `waiting_model` 挂起；例外——`models.yml` 里给 tier2 端点显式写了 `models.primary`（主人主动授权）才放行，且 `RouteMeta.degraded=true`、同值落 `model_call_log.degraded` 列——执行前后审查模块经 `meta()`/日志读取该位加验（§6.3）。`emergency_override` 类审批**不存在**（rev1 的悬空分支已删除，见评审响应第 10 条）。
- `mode_changed` 事件即时：(a) 写 `router_state`；(b) 广播给治理/队列；(c) 触发求救/恢复通报判定（§4.5）。mode 重算与 `emergencyActive` 位更新必须在**同一次 SQLite 事务**内完成后再广播。
- **降级即求救评估，升级必发恢复通报。** mode 变差（档位升高）时调用 `maybeSendHelp()`；mode 变好时调用 `sendRecovery()`（收敛规则见 §4.5）。

### 4.4 免费池测试：health check + 微型工具调用往返

两级测试，`probe_kind` 分别落库：

1. **health**（每 30min，心跳调度器触发 `pool.probe.${id}` light 任务）：`GET {base_url}/models` 5s 超时，期望 200 且 JSON 数组含声明模型名。失败 → 向该端点 light/primary 两轨各记一个窗口样本，kind=`pool_unverified`（常规退避起步 60s；**不是** engine_unavailable——见 §4.1 表的边界裁决）。
2. **tool_roundtrip**（health 通过后、且 `last_verified` 过期或从未验、或被首次选为 primary 候选时**按需/定期**执行）：

```
round 1: POST /chat/completions
  model=<候选>, temperature=0, max_tokens=64
  messages=[{user: "Call the echo tool with text 'ping-dotd'."}]
  tools=[{type:'function', function:{name:'echo', parameters:{text:string, required}}}]
  tool_choice={name:'echo'}
  通过判据：choices[0].message.tool_calls[0]
    .function.name==='echo' 且 JSON.parse(arguments).text==='ping-dotd'
round 2（条件）：把 round1 的 tool result（echo 原样回 'ping-dotd'）发回
  tool_choice='auto'
  通过判据：finish_reason 正常、content 非空（证明能吃工具结果继续说话）
预算：每 round 20s；任一轮超时/格式非法 → 失败，kind=bad_protocol
通过后：config 层把该条目 last_verified 写为当前时间（原子写文件 + 同步内存态）
```

- 测试请求计入 `breaker_sample`（失败照熔断），但不计入 `model_call_log`（probe 不是业务调用，记 `pool_probe_result` 即可）。
- 频率守卫：同端点 tool_roundtrip 每 15min 至多一次（免费池有日额度，rpd 未知时保守）。
- `ensureToolQualified(ep, deadline)` 语义：有新鲜合格证→返回 ok；无→在 `min(40s, remaining/2)` 内现测，成功写证、失败返回 not-ok 并落 `pool_probe_result`。调用失败时其 kind 由 route() 按 `pool_unverified` 入窗。
- **应急模式下的任务范围收缩**由 mode/emergencyActive 驱动，本模块只置位并广播（`{emergencyActive: true}`），收缩规则（低危放行、浏览器登录态强制审批）在治理模块实现——接缝见 §6。

### 4.5 求救消息：通道、模板、去重、恢复通报

**签名**：`signature = sha256(newMode + '|' + sorted('endpointId:track:kind' of failing) + '|' + tier)`。签名只由"故障集合"决定：OpenRouter 挂了又好了又挂（同一天内），只要故障指纹相同就是同一事件，24h 一条。

**投递协议——先记账后投递（补 rev1 缺口 9，杜绝崩溃窗口造成的重复求救）**：`alert_dispatch` 是去重的唯一账本，因此**任何投递动作之前**必须先在同一事务里 `INSERT … delivered_via='pending', channels_tried='[]'`。投递结果**回写**（UPDATE `delivered_via/channels_tried/delivered_at`）。重启时对账（§4.7）：`pending` 超 2min 的行视为"投递意图存在但未确认"——补投一次；再失败标 `lost`（不再自动重试，CLI `dotd models resend-help` 可人工触发）。由于账本先行，**同签名 24h 内绝不会二次进入投递路径**（CONTEXT:28 的硬保证）；代价是崩溃恰好在"已投未回写"窗口时会留下 pending 行并造成**最坏一次重复投**——这是"绝不漏发"优于"绝不重发"的有意取舍，且 Telegram 端消息可带 `[a1b2c3#2]` 签名标注重发。OUTBOX 追加同样先 INSERT 后追加文件（追加幂等检查：grep 同签名段落头存在则跳过）。

**同签名节流**：route() 内的 `enqueueHelpSoon()` 不直接投递，置 `helpDirty` 位，由 `breaker.probe_timer`（1min 心跳）统一结算——mode 一变差 1min 内发出，但高频失败不会轰击通道。

**maybeSendHelp 流程**：

```ts
function maybeSendHelp(failures, mode, taskImpact) {
  const sig = makeSignature(failures, mode);
  const open = db.getOpenAlert(sig);                 // resolved_at IS NULL 的行（含 pending）
  if (open && open.delivered_via !== 'lost') {
    if (now() - open.sent_at < 24h) return;          // 去重：静默
    else escalateReminder(open);                     // 同签名仍开放且超 24h → 再发一条（带 #N 标记）
  }
  const rowId = db.insert({signature:sig, kind:'help', mode, failing, served_by, 
                           task_impact: taskImpactProvider?.() ?? {queued_primary:null, running:null, held:null},
                           delivered_via:'pending', channels_tried:'[]', sent_at:now()});   // ← 先落账
  const channels = [];
  for (const ch of channelOrder()) {                 // ['telegram','email','outbox']，单通道 10s 超时
    if (!channelAvailable(ch)) { channels.push({ch, result:'unconfigured'}); continue; }
    const r = await channels_mod.deliver(ch, renderHelp(...));
    channels.push({ch, result: r.ok ? 'delivered' : r.error});
    if (r.ok) { db.updateDelivered(rowId, ch, channels); return; }   // ← 后回写
  }
  appendOutbox(renderHelp(...));                     // 最后一级：路由自己实现文件追加，永不失败
  db.updateDelivered(rowId, 'outbox', channels);
}
```

**help 模板**（Telegram/email/OUTBOX 同一模板，纯文本；`task_impact` 数字来自队列注入的 `taskImpactProvider()`，未注入时打"未知（队列未上报）"）：

```
🛟 dotd 求救 [a1b2c3]
模式: EMERGENCY（tier3 池服务中）｜时间: 2026-10-14 13:47 UTC+8
故障: openrouter-main/primary server_error×6, colibri-olmoe/light timeout×3
当前承载: pool:groq-llama-free（仅 light）；primary 任务挂起 4 个 / 运行中 0 个
应急收缩: 已生效（浏览器登录态操作全部转审批）
侦察候选: recon:7f3e21 groq llama-3.3-70b 免费1000/天 —— 回复 /approve recon:7f3e21 批准接入
本签名 24h 内不再重复打扰；恢复时另行通知。
```

**恢复通报与多行收敛（补 rev1 缺口 16）**：mode 变好时，把 `alert_dispatch` 中所有 `kind='help' AND resolved_at IS NULL AND signature != 当前故障集签名` 的行逐条收敛：

- 故障集与当前已恢复端点匹配（failing_json 中端点全部非 open）→ 发恢复通报（关联签名）、`UPDATE … resolved_at=now()`；
- 故障集中仍有 open 端点 → 保持 open（催救仍有效，24h 后可 escalate）；
- 多条同因开放行（签名略异）一次好转全部命中时，**合并为一条恢复通报**列出全部关联签名，逐行回写 `resolved_at`——杜绝 rev1"只解最老一行、新行持续催救"的漂移。

**恢复通报模板**：

```
✅ dotd 恢复 [关联 a1b2c3, d4e5f6]
模式: EMERGENCY → NORMAL｜历时 3h12m
恢复: openrouter-main/primary（半开 2 次真实调用成功）
影响: 挂起的 4 个 primary 任务已自动续跑
```

**通道可用性判定**（阶段一现实路径）：`telegram` 需通知模块报告 bot token 已配 + 最近 5min 内 getMe 成功；`email` 需 SMTP env 存在。不满足即 `unconfigured`，直接落到 outbox——**阶段一的求救实际全部走 OUTBOX.md，接口形态与阶段二完全一致**。

### 4.6 互联网侦察（只侦察不接入）

触发：mode ≠ NORMAL 时每 6h（`recon.interval_ms`）；TOTAL_OUTAGE 时侦察与真实重试交替。

流程：
1. 拉数据源（只读**元数据**，绝不向候选发 chat/completions 推理请求）：`openrouter_models` 源用 `GET /api/v1/models` 过滤 `:free` 后缀；`github_curated` 源经 `api.github.com/repos/…/contents/` base64 取回策展清单。**禁止直连 github.com/huggingface.co**（本机实测超时），如需人工参考镜像一律用 `hf-mirror.com`。
2. **去重与复活规则（补 rev1 缺口 7，`UNIQUE(base_url, model)` 下永不撞约束）**——按既有行状态分支：

   | 既有行状态 | 再次扫到时行为 |
   |---|---|
   | `needs_approval`（未超 7d） | UPDATE `evidence`/`updated_at`，**不重复发 `recon_proposal` 事件** |
   | `expired` | UPDATE → `state='needs_approval'`, `found_at=now`（复活重提案，发事件）——这是 expired 的唯一出边 |
   | `retired` | 同 expired：复活重提案 |
   | `rejected` 且 30d 冷却内 | 跳过，不出现 |
   | `rejected` 且已过冷却 | UPDATE → `needs_approval`，复活 |
   | `approved`（已批准未转 live） | 跳过（不重复提案；等审批回调或 §4.7 对账转 live） |
   | `live` | 跳过 |
   | 表内无行 | 查 `free-models.yml`/`models.yml`：已有同 base_url+model 条目 → 跳过（主人渠道优先）；否则 INSERT `needs_approval` 并按 `max_candidates_per_scan` 排序发事件 |

3. 排序取 top `max_candidates_per_scan`，逐条发 `recon_proposal` 事件（审批模块生成卡片）并并入下一次 help 的"侦察候选"段。
4. **批准落库（幂等定序，补 rev1 缺口 8）**：审批回调 `onApprovalResult('recon_candidate', id, approved=true)` → 在**当前事务**里先 UPDATE `recon_candidate.state='live'`，提交后再写 `free-models.yml`（文件写幂等：同 base_url+model 已存在则只 touch `updated_at`，不重复追加）。文件写失败（磁盘满/EACCES）：state 留在 `approved`，`reject_reason=null` 但记 `updated_at` 与内部错误，1min 心跳重试写文件、成功转 `live`。
5. 主人拒绝 → `state='rejected'` + `reject_reason`，30d 冷却生效。7 天无人理会（`found_at` 起算）→ janitor 置 `expired`。
6. 主人从 `free-models.yml` 手工删除条目 → §4.7 启动对账把对应 `live` 行置 `retired`。
7. 侦察源不可达不额外求救，下条 help 附"侦察候选: 无（源不可达: <错误>）"。

### 4.7 流式降级语义与启动对账

**流式规则（补 rev1 缺口 3、14；对齐 CONTEXT:44 journal"绝不重复执行"）**——本节定义 `stream()` 的全部结算时序：

- **分界点 = 首字节**。`meta()` promise 在选定端点、**首个 chunk 下发前** resolve；`RouteMeta.streamStarted` 自此为 true。
- 首字节**前**的一切失败等价于非流式：换下一候选，`recordOk/recordFailure` 在 `callEndpoint` reject 时点结算——journal 无感（一次 route 调用 = 一个步骤，内部换端点不算重放）。
- 首字节**后**断流（network）：路由**绝不自动换端点重放**（重发会向调用方吐重复内容，直接违反不重复原则）。行为固定为：抛出 `StreamInterruptedError { consumedTokens, textSoFar, meta }`，**同时** `recordFailure(ep, track, 'network')`（整流未完成不得 recordOk——窗口里它就是不健康），调用方（队列/journal）据 `consumedTokens` 决定整步重放还是部分采纳。**重放与否是 journal 的业务决策，不是路由的降级动作。**
- `meta()` 失败语义：首字节前全候选耗尽 → `meta()` reject 与 `stream()` 同步抛 `AllEndpointsDownError`/`NoQualifiedPrimaryError`（§4.2），`meta()` 永不挂起。
- `RouteMeta` 完整字段定义在 §3.1；`stream()` 返回 `{ [Symbol.asyncIterator], meta(): Promise<RouteMeta> }`。

**配置热加载的运行时重建语义（补 rev1 缺口 2 后半）**：`RouterRuntime.slots`（内存信号量 + busyConsec）以端点 id 为键、**跨 reload 存续**。reload diff 三类：新增 id→建 sem（容量取新配置 `max_concurrency`）；删除 id→sem **等在途释放完再回收**（上限 5s，超时强制丢弃，在途请求自然失败走降级）；改 `max_concurrency`→重建 sem，容量收缩时超出的在途不抢占、结束后自然收敛。`queue_reject_ms`/`warm_grace_ms` 等纯参数即时生效，无需重建。breaker 状态本就落 SQLite，与 reload 无关。

**启动对账（daemon boot，§5.1 `load()` 内执行）**，按序：
1. `alert_dispatch` 中 `delivered_via='pending' AND sent_at < now-2min` → 补投一次，失败标 `lost`（§4.5）。
2. `recon_candidate`：`approved` 且 `free-models.yml` 无对应条目 → 重试写文件转 `live`；有条目但未 `live` → 直接转 `live`（补齐断掉的迁移）。
3. `free-models.yml` 中 `live` 之外的 base_url+model 组合 ↔ `recon_candidate.state='live'` 双向核对，文件被手工删的行置 `retired`。
4. 从 `router_state` 恢复 mode/emergencyActive，立即重算一遍校验（配置可能已在崩溃期间被主人改过）。

### 4.8 非流式主流程与流式共用部分

`completeWithFailover` 与 `stream()` 共用 `pickCandidates`、breaker 闸门、预算切分与失败分类；差异仅在 §4.7 定义的结算时序。`callAndSettle` 内部：成功后 `model_call_log` 落一行（含 `degraded` 位与 `attempt_seq`），失败同样落行——`tried` 数组与日志行是一一对的两份记账，前者回给调用方、后者留库审计。

---

## 5. 对外接口

### 5.1 进程内 API（`src/router/ModelRouter.ts`，其余模块只 import 此类）

```ts
export interface TaskImpactProvider {        // 队列模块注入（§6.2），未注入时求救模板打"未知"
  (): { queued_primary: number; running: number; held: number };
}

export class ModelRouter {
  static load(deps: { db: SqliteDb; configDir: string; scheduler: HeartbeatApi;
                      channels: NotificationChannels | null;      // 阶段一传 null
                      bus: EventBus;
                      taskImpact?: TaskImpactProvider;             // 阶段一可缺省，阶段二队列模块接线时注入
                    }): ModelRouter;                               // load() 末尾同步执行 §4.7 启动对账

  // 核心调用面（队列/执行 Dot 的主循环与 light 分流都走这里）
  async complete(req: RouteRequest): Promise<RouteResult>;         // 非流式
  stream(req: RouteRequest): AsyncIterable<ChatChunk> & { meta(): Promise<RouteMeta> };  // RouteMeta 定义见 §3.1，resolve/失败语义见 §4.7
  trackForEvent(eventType: string): Track;                         // 读 routing.light_events 前缀匹配；入口模块用

  // 状态与运维
  snapshot(): RouterSnapshot;
  manualProbe(endpointId: string, kind: 'health'|'tool_roundtrip'|'breaker'): ProbeResult; // CLI 主动触发
  resetBreaker(endpointId: string, track?: Track): void;           // 主人手动放行（如换 key 后）
  reloadConfig(): void;                                            // models.yml 热加载（文件监听自动触发；runtime 重建语义见 §4.7）

  // 其他模块回调（唯一审批种类：侦察候选。rev1 的 emergency_override 悬空分支已删除）
  onApprovalResult(kind: 'recon_candidate', id: string, approved: boolean, note?: string): void;
  get emergencyActive(): boolean;                                  // 治理模块每次审批判定前读取
}
```

### 5.2 错误契约（调用方必须处理）

| 错误 | 含义 | 抛出点 | 调用方义务 |
|---|---|---|---|
| `AllEndpointsDownError(tried, helpAlreadyOpen?)` | 全部候选试过且失败 | §4.2 `buildExhaustedError` | 队列置任务 `waiting_model`，不重试消耗额度，等 `router.mode_changed(→better)` |
| `NoQualifiedPrimaryError(tried)` | RESTRICTED：唯一可见的是未持合格证的池模型，且存在待批侦察候选 | §4.2（条件构造，抛出点唯一） | 同上，且 help 消息必须附"待批候选"段提示主人批准 |
| `StreamInterruptedError{consumedTokens,textSoFar,meta}` | 流已开始后断流，路由不重放 | §4.7 | journal 决定整步重放或部分采纳 |
| `DeadlineBudgetError` | 调用方 deadline 耗尽 | §4.2 循环顶 | 视业务语义决定整步失败 |
| `AuthConfigError` | 鉴权类失败且已 open（open 后首个到达请求转抛此错而非继续转发 401） | §4.1 auth 分支 | 不等自动恢复——改配置/换 key 后调 `resetBreaker` |

### 5.3 事件（EventBus 主题）

发布：`router.mode_changed`、`router.breaker_changed`、`router.help_needed`、`router.recon_proposal`、`router.recovered`。
订阅：`approval.decided`（仅 `kind:'recon_candidate'`）、`config.models_reloaded`、`scheduler.tick.${name}`（pool.probe / recon.scan / router.janitor / breaker.probe_timer）。
跨模块数字（任务挂起/运行数）**不走事件**，走 `TaskImpactProvider` 同步回调（§5.1、§6.2）。

---

## 6. 与其他模块的接缝假设（仲裁依据）

1. **表所有权**：`breaker_state`、`breaker_sample`、`breaker_event`、`router_state`、`pool_probe_result`、`recon_candidate`、`alert_dispatch`、`model_call_log` 八张表**只归本模块读写**，migration 文件 `010_model_router.sql`。其他模块要状态一律走 `snapshot()`，不得自行 SELECT（防双写）。
2. **journal/控制面（队列模块）**：`RouteRequest.attemptId` 必须等于崩溃安全 journal 的步骤 id，同一步骤重试时 attemptId 不变。**attemptSeq 所有权（裁决）**：由**路由**在单次 `route()` 调用内从 0 自增（每尝试一个端点 +1），经 `RouteMeta.attemptSeq` 回传并落 `model_call_log.attempt_seq`；调用方不传、不维护。跨 route 调用（= 跨 journal 重试）的序号聚合以 `attemptId` 在日志表上 `GROUP BY` 即得，路由不持久计数器。队列收到 `AllEndpointsDownError` 后置任务 `waiting_model` 并订阅 `router.mode_changed` 续跑。**task_impact 注入契约**：队列实现 `TaskImpactProvider`（同步函数，返回 `{queued_primary, running, held}`，O(1) 读取），在 `ModelRouter.load` 的 deps 注入；未注入时求救模板打"未知（队列未上报）"，路由绝不自算。
3. **治理/审批模块**：应急收缩的**判定规则在治理侧**，路由只保证 `emergencyActive` 布尔位准确且随 `mode_changed` 即时更新（同事务落库后广播，§4.3）；浏览器登录态操作转审批由治理读取该位执行。**降级加验标记**：`RouteResult.meta.degraded === true`（tier2 授权降格承载 primary、或 tier3/4 承载）时治理/审查模块须对输出做执行后审查；该位同源落 `model_call_log.degraded` 列可事后审计。侦察候选审批：治理发 `approval.decided{kind:'recon_candidate', id, approved}`，路由在 `onApprovalResult` 消费，迁移与写文件的定序见 §4.6 第 4 步。
4. **事件入口/交互面**：入口模块用 `trackForEvent(eventType)` 决定打 `primary`/`light` 标签后入队；路由不感知事件语义。Web UI/CLI 状态页数据源 = `snapshot()` + `breaker_event` 时间线（经路由暴露的查询方法）。
5. **通知通道模块（SF）**：接口 `deliver(channel, text): Promise<{ok, error?}>`，10s 内必须结算，超时即换下一通道；通道优先级是路由侧的 channel_order 配置，不是通道模块的职责。2026-10-17 修（全方位测试高危"SOS 未接飞书"）：daemon 装配层在 MR 之前构造 `SurfacesNotificationChannels`（飞书网关 + 文件留痕）注入，MR 不再收 `null`；`available()` 一律问 SF——feishu = App 凭据齐且 5min 内成功发过/拿过 token，telegram 未装配恒 false，email 阶段一恒 false。
6. **心跳调度器**：路由注册四个定时任务——`pool.probe.*`（30min，light 轨）、`recon.scan`（6h，仅非 NORMAL）、`breaker.probe_timer`（1min，扫 `next_probe_at` 到期者 + 结算 helpDirty + 重试写文件）、`router.janitor`（每日，表回收 + 候选 TTL）。调度器不需要知道路由内部逻辑。
7. **执行面（Dot 容器）**：容器内工具**不直接调模型**；一切模型流量经宿主进程的路由出网。`engine_unavailable` 判定的本地探测（health/warm/槽位）只发生在宿主侧 127.0.0.1。
8. **记忆模块**：摘要/分流类调用经 light 轨走 `complete()`；记忆模块不得绕过路由直连本地引擎（否则 Colibrì 单飞槽位会互相挤爆，`max_concurrency:1` 的前提是全流量单点排队）。
9. **模型层既定事实落地**：主循环首选 OpenRouter（tier1 首位）、本地只做低智能分流、24h 求救去重 + 恢复通报、应急收缩任务范围、侦察需批准、base_url 热切换——全部对应 CONTEXT §模型层既定事实，逐条见 §7。

---

## 7. 遵守的 CONTEXT 约束清单

| CONTEXT 约束 | 本设计落点 |
|---|---|
| 完全自主，唯一外部依赖=模型 API，base_url 热切换 | models.yml `base_url` + reload 监听；"换供应商改一行配置"即改 id=openrouter-main 那行 |
| 主循环走 OpenRouter、工具调用能力必需、本地 7B 撑不起主循环 | tier1 首位默认 OpenRouter；LOCAL_FALLBACK 下 primary 不入本地除非显式授权+degraded 加验（§4.3）；池模型无 tool 合格证不得承载 primary（§4.4） |
| 双轨路由：低智能高频调用走 Colibrì/Ollama | Track=light 的候选序 tier2 前置于 tier3；`trackForEvent` 前缀表；light 轨不受 emergencyEligible 过滤 |
| 三级降级阶梯 + 熔断器 SQLite 持久化 | Tier1-4 单向扫描 §4.2；`breaker_state`/`breaker_sample` 落库 §3.2 |
| 免费池 health check + 微型工具往返测试 + 应急收缩任务范围 | §4.4 两级测试；emergencyActive 位 §4.3；emergencyEligible 唯一执行位点 §4.2 pickCandidates |
| 侦察只提案、接入必须批准 | §4.6 元数据only + 状态机（含复活/退役出边）+ 审批回写 + 启动对账 §4.7 |
| 同一故障 24h 只求救一次；恢复发通报 | 签名去重 + 账本先行协议 §4.5；多行恢复合并 §4.5 |
| Telegram 优先、email 兜底、OUTBOX.md 再兜底 | channel_order（2026-10-16 改飞书首位）+ 逐级 available 跳过 + OUTBOX.md 末级兜底 §4.5 |
| Colibrì 尽力而为、要能探测不可用并再降级 | local.health/warm/槽位三道闸 + engine_unavailable + busy_consec_limit 强制降级（§4.1）；max_concurrency:1（机器实测无 batching） |
| 与 netfuzz 负载共存、不假设独占、内存吃紧本地不可靠 | warm_grace 防半加载误判、queue_reject 8s 快速放弃、busy 三连强制入窗（§4.1）、表体积上限与 janitor 回收（C:/D: 盘约束） |
| TypeScript 单进程 + SQLite 单写者 | 路由是 daemon 内模块，无独立进程、无网络端口，全部经 better-sqlite3 同步事务 |
| 崩溃安全步骤级 journal"绝不重复执行" | attemptId 对账（§6.2）+ 流式首字节后不重放（§4.7）+ 求救账本先行（§4.5） |

---

## 8. 开放问题（需主人/仲裁拍板）

1. **OLMoE 是否具备任何工具调用能力未实测**——当前设计直接把它锁在 light 轨（`models` 只写 light）。若实测可用，`models.yml` 加一行即可放开，无需改设计。
2. **免费池鉴权边界**：多数"免费"池（含 OpenRouter `:free`）仍要求一个 API key，与"OpenRouter 挂了"同时发生时其备用价值折损。是否为主人准备一个独立的 OpenRouter `:free` 专用 key 并在 free-models.yml 里显式收录，需要决策；否则 Tier3 对 tier1 故障的相关性下降。
3. **email 兜底的凭证与可达性**：本机 SMTP 出口是否可用未验证（网络存在 github/hf 被墙先例）。阶段二实装前需一次真实发送测试。
4. **quota 型 429 的文案识别清单**（groq/openrouter 等的 quota body 措辞）需要在实现期建正则集，误判代价是白等 30min backoff。
5. **LOCAL_FALLBACK 下 primary 挂起 vs 降格到 7B 跑"降智版"**：默认挂起最稳，但主人是否接受对少数低风险任务显式授权 7B 降级执行（`models.primary` + `degraded:true` 加验路径已预留），属于产品口味，留给主人。
6. **多 primary 候选的会话粘性**：同一会话中途端点轮换（A 挂→B）时历史消息里可能混着两家风格；是否需要路由侧做消息格式规范化（如剥离各家的 reasoning 字段），倾向"要"，成本小，等仲裁确认。
7. **`half_open_busy_skip` 的 primary 轨体验**：当前裁决是并发请求直接跳过半开端点走向降级（§4.1）。对单用户个人系统，这意味着 OpenRouter 恢复瞬间的第一个任务仍可能落到降级链上。备选：primary 轨允许排队等探活最多 15s。默认取"跳过"（宁降级不等待），留给主人改配置项。

---

## 9. 评审响应（rev1 → rev2，逐条）

1. **emergencyEligible 无执行位点** — 已在 §4.2 `pickCandidates` 增加唯一执行位点并写明裁决：`mode ∈ {EMERGENCY,RESTRICTED,TOTAL_OUTAGE}` 且 `track='primary'` 时过滤掉 false 端点；LOCAL_FALLBACK 与 light 轨不受影响；被过滤不写 tried。models.yml/类型定义处加注互指，§3.1 增加字段注释。
2. **`ep.localSlot` / `req.queue_reject_ms` 幽灵字段** — `queue_reject_ms` 统一为端点配置（`ep.local.queue_reject_ms`，RouteRequest 注释明确无覆盖通道）；信号量移入 `RouterRuntime.slots`（配置对象与运行时态分离）；跨 reload 存续与三类 diff 重建语义写入 §4.7。
3. **流式降级未覆盖** — 新增 §4.7：首字节为分界，前失败可换端点、后断流绝不重放（抛 `StreamInterruptedError` 交 journal 裁决），`recordFailure` 在整流未完成时点结算、整流成功才 `recordOk`；对撞点用"重放与否属业务决策"划清与 CONTEXT:44 的边界。
4. **half_open 无选取分支** — §4.2 循环加 `half_open` 分支（`halfOpenSlot.tryAcquire` 失败 → `half_open_busy_skip` 继续下一候选），§4.1 写明并发裁决与理由，`model_call_log.outcome` 增加该枚举值；开放问题 7 记录"跳过 vs 排队 15s"的默认取舍。
5. **预算算术矛盾** — §4.2 预算规则重写：轨默认总预算 primary 300s/light 60s（300s 的可行性算式写在代码注释），单候选 `min(total_ms, max(remaining/2, 5s))` 切分；`models.yml` 注释提示主人收紧多 tier1 端点的 total_ms。
6. **degraded 标记无契约位置** — `RouteMeta` 增 `degraded: boolean`（§3.1），`model_call_log` 增 `degraded` 列（§3.2），§4.3/§6.3 接缝条款改为明确"审查模块经 meta()/日志读取该位"。
7. **recon_candidate 断头分支** — §4.6 第 2 步改为八行状态分支表：expired/retired 复活回 needs_approval、rejected 过冷复活、approved 跳过不重提案、live 跳过；DDL 注释补全状态图并加 `retired` 枚举值与 `updated_at` 列，`UNIQUE(base_url,model)` 下走 UPDATE 永不撞 INSERT 约束。
8. **批准落库非原子、崩溃恢复缺失** — 定序裁决为"事务内先 UPDATE live，提交后幂等写文件"（文件写失败留 approved+心跳重试）；新增 §4.7 启动对账第 2/3 步补齐断掉的迁移；§5.1 `load()` 注明同步执行对账。
9. **求救投递与记账非原子** — §4.5 改"账本先行协议"：INSERT pending → 投递 → UPDATE 回写；崩溃对账补投/标 lost；文档明确取舍（绝不漏发 > 绝不重发，最坏一次重复且带 #N 标注）；OUTBOX 追加前先落账 + 幂等 grep。
10. **emergency_override 悬空分支** — 采纳"凭空多出的入口"批评：**删除**该 kind（§5.1 签名只留 recon_candidate），§4.3/§6.3 不再引用；降格授权的唯一路径就是改 `models.yml`（配置即授权，热加载生效），与其再造一个审批状态机不如保持单一事实源。
11. **task_impact 无接口** — §5.1 新增 `TaskImpactProvider` 类型并入 `load(deps)`；§6.2 写明由队列实现、同步 O(1)、未注入时模板打"未知（队列未上报）"；§5.3 注明该数字不走事件走回调。
12. **engine_unavailable 定义域矛盾** — 裁决：`engine_unavailable` 严格限 Tier2（health/warm/busy三连）；Tier3 池探测失败新增 `pool_unverified` kind（常规 60s 退避起步）。§4.1 表、§4.4 第 1 条、DDL 注释三处统一。
13. **NoQualifiedPrimaryError 无抛出点** — §4.2 新增 `buildExhaustedError`（唯一裁决函数）：池候选被合格证挡下 + 无其他硬故障 + 存在待批侦察候选时抛此错；条件与"提示主人批准"的 help 分支接通；§5.2 表补"抛出点"列。
14. **RouteMeta 未定义** — §3.1 给出完整接口定义（字段、degraded/attemptSeq/streamStarted 语义），§4.7 定义 resolve 时点（首字节前）与 reject 语义（与 stream() 同步抛耗尽错误、永不挂起）。
15. **恢复通报只解最老一行** — §4.5 改写收敛规则：mode 变好时按 failing_json 逐行核对，全恢复行 resolve、部分恢复行保持 open、多命中合并为一条恢复通报列全部关联签名。
16. **attemptSeq 所有权矛盾** — §6.2 明确裁决：路由在单次 route() 内自增、经 RouteMeta 回传、落日志；调用方不传（RouteRequest 注释同步删除该入参字段）；跨调用聚合靠 attemptId GROUP BY，路由不持久计数器。
17. **Tier2 槽位满是否入窗前后不一** — 裁决写入 §4.1 表：单次 busy 不入窗（排队非故障、且同端点可能有请求正在成功），但 `busy_consec_limit=3` 连续 busy → 记 engine_unavailable 入窗并按 5min 退避——"长期半死不活"必然触发降级与 mode 重算；`breaker.busy_consec_limit` 进配置，`RouterRuntime` 持 busyConsec 计数器，成功获取即清零；§4.8 补 `callAndSettle` 的日志/计数细节（degraded 位落行、tried 与日志一一对），防"两套记账漂移"。
（注：评审批次共 17 条，本表编号与引文顺序一一对应。）
