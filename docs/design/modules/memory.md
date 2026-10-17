# 模块详设：记忆系统（memory）

> 契约来源：`dotd-design/CONTEXT.md`。本文遵守其全部既定决策，特别是第 21 行「记忆两层 = /dot/home 文件记忆 + SQLite 会话历史，起步不上向量库」，以及第 18 行 SQLite 单库承载「会话历史」、第 20 行 `/dot/home` 容器卷、第 22 行 OUTBOX.md 兜底通道、第 27 行双轨路由。
> **rev2**：按跨模块评审修订 15 条缺口；凡与其他模块已定稿契约冲突处，一律以对方定稿为准并记入文末「评审响应」。

---

## 1. 模块职责与边界

### 1.1 职责

| 层 | 职责 |
|---|---|
| 文件记忆 | `/dot/home` 的目录规范、笔记/操作手册文件格式约定；任务开始时的**注入读取**与任务结束时的**写入收口**；文件访问经由执行面已定稿的 `fs.*` 原语（§5.2，本模块定路径/限额/元信息约定，不另造工具名）；大小上限、整理（compaction）与归档策略；跨重启、跨容器重建的持久化 |
| SQLite 会话历史 | 线程（thread）= 会话（session）的单一模型；与任务（tasks）、事件（events）的关联；上下文重建（`memory.load/create`，供 Runner 恢复）；保留期与清理；grep 级检索与空结果率埋点 |
| 升级判据 | 「何时该上向量库」的触发信号与埋点归属（§6.4） |

### 1.2 边界（明确不做）

- **不拥有**：任务队列与步骤级 journal（控制面）、审批状态机与审计日志（治理）、模型调用（ModelRouter）、容器与卷的物理生命周期（执行面）。
- **不做语义检索 / 不部署向量库 / 不做 embedding**（CONTEXT 第 21 行），升级判据见 §6.4。
- **不直接调模型**：摘要、整理定义任务契约（§4.4/§4.5），由控制面投递、ModelRouter 按 track 路由；失败降级为不摘要。
- **不主张工具命名空间**：治理规则按执行面注册名逐字一致（governance.md:80），本模块不再定义 `memory_*` 工具名（rev2 修订，见 §5.2）。
- **不主张 OUTBOX.md 格式所有权**：写者是模型路由（model-router.md:526）与交互面 Telegram 适配器（surfaces.md:378），格式以路由定稿为准；本模块只承担超限时按块轮转（§3.6）。

---

## 2. 设计原则（源自 CONTEXT 的硬约束推导）

1. **记忆必须可 grep、可读、可迁移**：文件记忆一律纯文本 Markdown（归档也保持 `.md`，rev2：放弃 tar 归档以保住"可 grep"，§3.5）；SQLite 单文件、WAL。迁移 = 拷 `~/.dotd/` 目录 + `docker volume` 导出。
2. **记忆是资产不是负债**：容量硬上限（盘小，CONTEXT 第 37 行），超限先整理、再归档、最后删除，删除前必留摘要指纹。
3. **崩溃安全**：文件写 = 原子替换（tmp+rename，经 §5.2 的约定落实）；会话消息逐条即时落库，且与 journal 同等级别持久（`synchronous=FULL`，rev2 让步，§5.3）。
4. **上下文注入预算制**：注入内容由固定 token 预算决定（§4.2）。
5. **单人单 Dot 起步，模型预留 dot_id**：占位值统一 **`'dot1'`**（与 control-plane.md:82/129 `DEFAULT 'dot1'` 对齐，rev2），阶段三多 Dot 不重构。

---

## 3. 文件记忆：`/dot/home` 规范

### 3.1 物理布局与访问路径（rev2 重写：以执行面已定稿的命名卷为准）

执行面已定稿：home 卷为 **docker 命名卷** `dot-<dotId>-home` 挂载到容器 `/dot/home`（execution.md:153），容器内另有保留目录 `/dot/home/.dotd/`（token/ledger，execution.md:143/229/315）。**本模块接受该形态**，不再要求 bind mount。由此产生两条铁律：

```
铁律A：所有文件记忆的"写"与"整理/归档"发生在容器内（Dot 经 fs.* 工具，
        维护操作经执行面 /fs/ops 桥，见下）。宿主机 daemon 不直接 walk 卷目录。
铁律B：daemon 侧的唯一"读"路径 = 经 agent-runtime 的 home 文件系统桥
        （execution.md §5 HTTP API，:9223，Bearer token 鉴权，execution.md:189）。
```

```
容器内规范路径（本模块定义的目录规范）：
/dot/home/
├── MEMORY.md          # 索引 + 当前关切（4 KB 硬限）
├── notes/             # 情景记忆，YYYY-MM-DD-<slug>.md；月度摘要 YYYY-MM-digest.md
├── manuals/<domain>/  # 操作手册（web/gh_login.md 等）
├── .archive/          # 归档区：保持 .md 原文件移入（不打包，供 grep），32 MB FIFO
├── .tmp/              # 原子写暂存区（.dotd 之外，供本模块 tmp+rename）
└── .dotd/             # ⛔ 执行面保留（token/ledger.jsonl），记忆层不索引、不整理、不注入

宿主机（WSL 内）：
~/.dotd/               # 数据目录根（surfaces.md:5）—— SQLite、配置、OUTBOX.md 所在
~/.dotd/dotd.db        # 唯一库文件（§5.3），全系统统一此名（rev2，见评审响应 #1）
```

- daemon 侧需要列举/读取 home 内容（注入读取、索引对账）时，调 `POST /fs/ops {op:'read'|'list'|'stat', path:<home 相对路径>}`；该端点与 `fs.read/fs.list` 共享路径沙箱（`startsWith` 解析 + symlink 双查，execution.md:310）。此桥端点为对执行面的接缝要求 **S4'**（§7）。
- **备份与迁移**：`docker run --rm -v dot-<id>-home:/h alpine tar czf /backup ...` 或主人直接取 `/var/lib/docker/volumes/dot-<id>-home/_data`（阶段一由主人手工执行，`dotd notes backup` 指令列入阶段三）。
- 交互面"文件记忆浏览页"按 surfaces.md:473 属阶段三——本模块不与之冲突：**daemon 的桥读取只用于注入与维护（机器路径），UI 展示层届时同样经本模块 MemoryService 取数（S11），不另开直读卷路径。**
- 容器未在跑时的注入降级：见 §4.2（任务开始前控制面本就会确保容器就绪；桥不可用则本次注入仅 SQLite 部分并记 `memory_missed`）。

### 3.2 文件格式约定

**MEMORY.md（索引 + 当前关切）** —— 唯一保证被注入的文件，尺寸最严：

```markdown
# MEMORY (index)
updated: 2026-10-14T09:30Z        # 机器可校验的第一行时间戳
## Interests                     # ≤10 条，一行一条短句
- 主人关注 GitHub 上的 CVE 情报
## Current concerns
- gh 登录 flow 改版，manuals/web/gh_login.md 待验证
## Pointers                      # 指向其他文件的 home 相对路径 + 一句话
- notes/2026-10-12-incident.md   # 上周 rate-limit 事故复盘
```

约定：段落名固定（`Interests / Current concerns / Pointers`），Dot 整理时只允许增删条目、不改段落结构，保证 §4.2 预算函数的解析器简单可靠。

**notes/*.md（情景记忆）** —— 命名 `YYYY-MM-DD-<kebab-slug>.md`（月度摘要 `YYYY-MM-digest.md`，下划线开头的 `_compactions.md` 为整理留痕，均不计入文件数上限）。文件头元信息行：

```markdown
date: 2026-10-14
task: tk_01JD3X…        # 关联任务 id，可空
tags: [github, incident]
---
正文自由 Markdown。一事一文件。写"发生了什么、结论是什么"，操作步骤归 manuals。
```

**manuals/<domain>/*.md（操作手册）** —— 写给未来的自己照做，固定小节：

```markdown
# <手册名>
domain: web
status: verified | draft | stale    # stale = 前提已失效，等待重写
last_used: 2026-10-14               # 整理老化按此字段（§3.5）
## When to use
## Steps          （编号步骤，含具体选择器/命令）
## Pitfalls
```

### 3.3 读写时机（状态机）

```
[任务开始] → READ-INJECT（经桥读 MEMORY.md + 按需读 manuals，拼上下文包 §4.2）
    → [任务执行中] → 工具级读写（fs.* + shell.run，随时可发生）
    → [任务终态 done|failed|cancelled] → WRITE-SEAL（强制收口，§4.3——三种终态全走，rev2）
    → [整理窗口] → COMPACT / ARCHIVE（§3.5，由心跳触发、容器内执行）
```

- **开始读取**：MEMORY.md 无条件注入；其余文件**不预取全文**——Dot 用 `shell.run("grep -rn …")` 或 `fs.read` 自取。刻意为之：盘小 + 预算紧，按需检索优于全家桶塞 prompt。
- **结束写入**：任务终态必经 WRITE-SEAL 门（§4.3）。
- **写入即持久**：SQLite 消息逐条 `INSERT`，`synchronous=FULL`（rev2：与 journal 同级，放弃"可丢最后一个 checkpoint 周期"的旧论证，§5.3）。文件原子写 = `fs.write('/dot/home/.tmp/<uuid>.md')` → 经 `/fs/ops {op:'rename'}` 落到规范路径（§5.2）。

### 3.4 大小上限与超限行为（硬数字；rev2 加"与执行面限额的关系"）

| 对象 | 软限（告警，写入响应附精简建议） | 硬限（拒绝/强制整理） |
|---|---|---|
| MEMORY.md | 3 KB | 4 KB |
| 单个 note / manual | 8 KB | 16 KB |
| notes/ 未归档文件数 | 60 | 120（触发强制整理 §4.5） |
| manuals/ 总大小 | 200 KB | 512 KB |
| home 全量（不含 .archive/.dotd/.tmp） | 1 MB | 2 MB（超限 → 只读期，整理后放行） |
| .archive/ | — | 32 MB，按批次 FIFO（主人可 pin） |

**与执行面限额的关系（唯一裁决，rev2）**：`fs.read ≤4MB / fs.write ≤8MB / home 卷 2GB 超限告警不删`（execution.md:310/311/464）是**物理兜底层**，保留不动；上表是**策略层**，全部严于兜底，由记忆层检查点强制（§5.2 的 service 级校验 + 工具响应 warning）。**冲突时以更严者生效**：一个 20 KB 的 note 会被记忆层拒绝，即使 fs.write 允许。home 总用量 2 MB（策略）≪ 2 GB（卷配额），后者仅由执行面告警，本模块不消费。

告警实现：写工具返回值附带 `{warning: "MEMORY.md 3.1/4 KB，建议合并 Interests 第4、7条"}`，让 Dot 当轮自我修复。

### 3.5 整理（compaction）策略

低智能后台任务（投队列走 light 轨，§4.5；失败即跳过，绝不阻塞主循环）：

- **触发**（心跳 job `memory-compaction` 每小时探测，任一满足即投递）：
  1. notes/ 未归档文件数 >60，或存在 >30 天未归档 note；
  2. home 全量 >1 MB；
  3. 每 14 天兜底轻量版（只重写 MEMORY.md Pointers、老化 manuals status）。
- **动作序列**（容器内执行，经 `/fs/ops` 桥的维护模式，见下；**不使用 shell.run**，免审批歧义——shell.run 属命令执行类、sideEffect 治理分类会触发审批（execution.md:313 / governance.md:80），后台维护任务不应逐个卡审批）：
  1. 同 tag 碎 note 合并为月度摘要 `notes/YYYY-MM-digest.md`；
  2. 被替代的原始 note **整文件移入** `.archive/notes-2026-09/<原文件名>.md`（保持 .md，ripgrep/grep 可直接回溯，rev2：废除 tar 方案）；
  3. manuals：`last_used` >90 天 → `status: stale`；>180 天且 stale → 移入 `.archive/manuals-stale/`；
  4. MEMORY.md 重写（去重、Pointers 只指向未归档、砍过期 concerns）；
  5. 留痕：`notes/_compactions.md` append 一行 `date, files_merged, bytes_freed`。
- **不可逆保护**：整理只向 `.archive/` 移入、不删除；真删除仅 `dotd notes purge`（主人显式，§3.4/§6.1）。
- **`.archive/` 检索约定**：`fs.list/fs.read` 默认含 .archive（Dot 显式传路径即可读）；记忆层的常规检索（注入 Pointers、对账索引的"活跃集"）不含 .archive，检索工具加 `includeArchive` 显式参数才覆盖（§5.2/§6.4）。

### 3.6 OUTBOX.md（rev2 重写：所有权让渡，格式对齐模型路由）

位置与格式均按已定稿模块对齐，本模块**不再主张格式所有权**：

- **位置**：`~/.dotd/OUTBOX.md`（daemon 宿主机文件，surfaces.md:378 已定稿；model-router.md:113 的 `/dot/state/OUTBOX.md` 与之冲突，已列为跨模块待仲裁，见开放问题 Q2——本模块按 `~/.dotd/` 设计，因 surfaces 的 Telegram 失败兜底与 daemon 崩溃路径都落在此）。
- **追加格式**：以模型路由定稿为准（model-router.md:526）：`## [YYYY-MM-DD HH:mm] HELP <sig>` + 模板正文 + `---` 分隔的**块结构**；恢复状态以路由 `alert_dispatch` 表为准，OUTBOX 内不回写。
- **本模块保留的职责 = 体积守门**：超 64 KB / 200 个块时按**块**轮转进 `.dotd/archive/outbox-<批次>.md`（仍在 `~/.dotd/` 下，daemon 自己就是写者之一，不依赖容器）；**未收敛（HELP 块签名在 `alert_dispatch` 中无 `resolved_at`）的块永不轮转**——本模块需读路由库表 `mr_alert_dispatch`（同库，S1 命名空间）判定收敛，查不到表时保守全留。
- 文件监听器可 tail 此文件自检（保持块首行可被 `tail -n 20` 直读）。

---

## 4. 关键流程与状态机

### 4.1 会话模型与上下文重建（rev2：thread = session 合一）

**裁决：`thread` 即 `session`，同一个 id。** 控制面的 `tasks.session_id`（control-plane.md:137）与 `tasks.thread_id`（:138）取值相同，均为本模块 `mem_threads.id`；本模块接口同时提供别名方法 `sessions.get(id) ≡ load(id) ≡ getThreadWithMessages(id)`（§8），以匹配 control-plane.md:447/555 已写死的调用形态。`session_id` 列由控制面自行合并或保留为冗余别名，不属本模块决定范围。

任务↔线程关联：

- 对话任务：交互面带来的消息先 `openThread(channel, externalRef)`，`ControlPlane.submit` 须带 `threadId`（对控制面的接缝要求 S2：submit 请求体增 `threadId?: string` 字段——control-plane.md:461 现签名缺此参数，列为开放问题 Q1 待其接受）。
- 事件/心跳任务：**先建任务、后建 thread**——由 Runner 首步调 `memory.create()` 建 thread 并**自行回写 `tasks.thread_id`**（回写通道：控制面暴露 `setThread(taskId, threadId)` 或由 Runner 直接 UPDATE tasks——裁决倾向后者，属控制面内部，本文按"Runner 负责回写"设计）。`openThread` 对 event/heartbeat 通道 `external_ref` 恒为 NULL，幂等靠 `event_id`/`origin_task_id`（§5.3 注，rev2 修正）。
- 恢复重建：Runner 重领任务 → `memory.load(task.session_id)` 取 `thread + context_summary + messages` → 按 §4.2 预算从新到旧装填，最老未装部分由 summary 兜底。

### 4.2 任务开始注入（预算函数）

```
注入内容 = MEMORY.md（≤4 KB，经 /fs/ops 桥原文读取，必进；桥不可用 → 本次跳过并在 messages 记
                      kind='system_error' 注记 + memory_missed=1，不阻塞任务）
         + manuals 匹配片段：任务文本 tokens ∩ 文件头/首行关键词朴素匹配，top-2，每篇截前 1 KB
         + thread.context_summary + 近 8 条消息（若该 thread 有历史）
         + notes 不注入，只给 MEMORY.md 的 Pointers 列表（Dot 自取）
预算：文件记忆部分 ≤ 2500 tokens；会话历史部分 ≤ 4000 tokens；
     超预算砍序：manuals 片段 → 消息条数 → context_summary 最后才动。
估算统一 chars/3.5（中英混排近似，无 tokenizer 依赖）。
```

### 4.3 任务结束写入收口（WRITE-SEAL，三种终态全走；rev2 补分支）

```ts
async function sealTask(task: Task, outcome: 'done'|'failed'|'cancelled', reason?: string) {
  insertSystemMessage(task.threadId, { kind: 'task_end', outcome, stopReason: reason });
  UPDATE mem_threads SET last_task_finished_at = now() WHERE id = task.threadId;  // §6.1 封存锚点（rev2）
  if (outcome === 'done') touchManualsLastUsed(task.newManualIds);
  const wroteMemory = await anyMemoryFileTouchedSince(task.startedAt); // 查 journal 步记录（工具名 fs.write/shell.run 命中 /dot/home 规范路径）
  if (!wroteMemory) {
    if (outcome === 'done') {
      injectOnce(task, "若本次有可复用经验，现在写 notes/ 或更新 manuals/，否则回复 SKIP");
    }
    // failed/cancelled：不追加提醒轮（止损优先），只记 memory_missed=1 供复盘
    markMemoryMissed(task.id);
  }
}
```

**对控制面的硬要求（S2'，rev2）**：`finish()`、watchdog 失联回收、背压 kill、优雅关停等**所有**使任务进入 `failed/cancelled` 的收口点，都必须调用 `sealTask(task,'failed'|'cancelled',stopReason)`——否则 §6.3 的恢复扫描会把它们误报为会话断点（control-plane.md:574 目前只在正常退出路径 writeFileNotes，此为对方文件需补的一行，记入开放问题 Q1）。

### 4.4 长线程滚动摘要

thread 消息数 >64 或注入估算超 4000 tokens → 投递摘要任务（light 轨）：输入 = 最老 32 条 + 旧 summary；输出 = 新 `context_summary`（≤600 tokens，`## 已定事实 / ## 未决问题 / ## 最近动作`）；**回写通道 = `MemoryService.updateContextSummary(threadId, summary, uptoSeq)`**（§8 补齐，rev2）。被覆盖的最老消息不删（归 §6.1）。摘要失败（本地模型不可用，CONTEXT:36）→ 跳过，注入退化为"最近 8 条 + 旧 summary（若有）"。

### 4.5 整理/摘要任务的投递路径（rev2 补，原缺口）

两类内部任务都经 **`ControlPlane.submit`** 投递，载荷通道约定：

- 向 submit 请求体请求增可选字段 `payloadJson?: string`（控制面存 tasks 侧或本模块侧映射表均可，本模块只依赖 `CompactionJobSpec` 能在 Runner 侧被还原）；**过渡方案**（控制面未接受前即用）：jobId 编码进 `tasks.title` —— `title: "mem:compaction:<specId>"`，spec 存 `mem_maintenance_state.payload:<specId>`，Runner 按前缀解析。两种通道内容结构相同，接受一种即可切换，不阻塞施工。
- **track 对接**：路由无 `routeHint` 概念，定稿的是 `Track = 'primary'|'light'` 与 `trackForEvent` 前缀表（model-router.md:160/686）。约定：本模块内部任务的 task 打标 `track='light'`；若其经事件管线产生，事件类型前缀取 `memory.*`，由控制面/入口把 `memory.*` 加入 `routing.light_events` 前缀表（model-router.md:92 配置项）。S8 相应改写（§7）。
- 任务失败语义：light 轨候选全部不可用时**快速失败**（路由侧 deadline 60s，model-router.md:424），本模块接受跳过本轮整理/摘要。

### 4.6 与 journal / 审批的关系

- 工具调用全量参数/结果只进执行面/控制面 journal；`mem_messages` 的 tool_call/tool_result 只存 `{tool, args_digest, result_digest}`（hash + 200 字符预览）。
- 审批结果作为 `kind='approval_verdict'` 系统消息进 thread；审计真源在治理表。

---

## 5. 数据结构

### 5.1 类型定义

```ts
export type MemoryArea = 'memory' | 'notes' | 'manuals' | 'archive';   // rev2：删除 'outbox'（迁到 daemon 侧 ~/.dotd）与 'tmp'（不索引，§6.2）
export type HomeRelPath = string;   // home 相对路径，如 'manuals/web/gh_login.md'（唯一权威域，rev2）
                                     // 容器绝对路径 = '/dot/home/' + HomeRelPath，由 exec 工具层拼接，本模块接口不出现绝对路径

export interface MemoryFileRef {
  path: HomeRelPath;
  area: MemoryArea;
  sizeBytes: number;
  softLimit: number; hardLimit: number;   // §3.4 表
  mtime: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  warning?: string;
  error?: 'HARD_LIMIT' | 'NOTES_COUNT_LIMIT' | 'HOME_CAPACITY' | 'READONLY_PHASE';
}

export interface ContextBundle {
  memoryMd: string;
  manualExcerpts: Array<{ path: HomeRelPath; text: string }>;
  summary: string | null;
  recentMessages: Message[];
  usedTokens: number;
}

export type ThreadChannel = 'web' | 'telegram' | 'cli' | 'email' | 'event' | 'heartbeat';
export type ThreadStatus = 'active' | 'idle' | 'sealed' | 'purged';
export type MsgRole = 'user' | 'assistant' | 'system';
export type MsgKind = 'text' | 'tool_call' | 'tool_result' | 'approval_request'
                    | 'approval_verdict' | 'task_start' | 'task_end' | 'memory_note' | 'system_error';
export interface Message { id: string; threadId: string; seq: number;
  role: MsgRole; kind: MsgKind; content: string; taskId?: string; eventId?: string;
  tokenEst: number; createdAt: number; }

export interface CompactionJobSpec {   // 经 §4.5 通道投递
  jobId: string;                         // specId，编码于 title / payloadJson
  kind: 'memory-compaction' | 'memory-summarize';
  dotId: string;
  threadId?: string;                     // summarize 时必填
  triggers: string[];
  dryRun: boolean;
}
```

### 5.2 工具契约（rev2 重写：对齐执行面已注册名，不再造 memory_*）

Dot 侧**只有**执行面已定稿的工具：`fs.read / fs.write / fs.list / fs.stat / shell.run`（execution.md:310-313，governance.md:80 要求规则名逐字一致——本模块所有审批规则/档位目录按这五个名字书写）。记忆约定体现在**参数纪律与限额**上，由以下三个记忆层检查点强制（实现归控制面 Runner 的工具前置钩子，调用本模块 service；执行面 fs.* 不感知记忆语义）：

1. `beforeWrite(path: HomeRelPath, content: string): MemoryWriteResult` —— fs.write 前查 §3.4 限额，软限 warning 以响应附注回传模型。
2. `atomicWrite(path, content)` —— 原子写义务（rev2 显式落实）：`.tmp/<uuid>.md` → rename；rename 经 `/fs/ops`（S4'）。
3. 检索 = `shell.run("grep -rn --include='*.md' <query> /dot/home/{notes,manuals}")`，service 侧封装 `searchHome(query, opts)` 仅用于维护任务，不进模型工具面（避免双轨检索）。

对执行面的接缝要求（§7 S5）：`fs.list/fs.stat` 返回值附带字节数供限额检查；`/fs/ops` 桥支持 `read/list/stat/rename` 四 op（rename 限 home 内）。

### 5.3 SQLite 表（全量 DDL）

库文件 **`~/.dotd/dotd.db`**（全系统唯一名，rev2 裁决，见评审响应 #1）。**连接与 PRAGMA（rev2 重写）**：

```
本模块与 journal 同用 better-sqlite3 同步接口；单进程内建议共享一条连接
（control-plane.md:220 已定 "Telegram/HTTP 循环共享同一 db 连接"）。
连接级 PRAGMA（谁先建立连接谁设，本模块不自设冲突值）：
  journal_mode=WAL（库级持久，各模块一致）
  synchronous=FULL（rev2：向控制面 R3 让步；messages 单条 INSERT 微秒级，
             性能损失可忽略，放弃 NORMAL 的"可丢一 checkpoint 周期"论证）
  busy_timeout=5000
foreign_keys：连接级，默认 OFF。本模块 mem_* 内部 FK（threads→messages CASCADE）
  属"本模块自己的连接开启即受益、不开启也不破"的弱依赖——DDL 保留 REFERENCES 声明，
  但不得设为全局 ON：control-plane.md:136 的 tasks.source_event_id REFERENCES events(id)
  与其 :409 events 90 天 TTL 删除在 FK ON 下直接冲突（评审 #2）。
  裁决：FK 语义由"写入顺序自律"保证（本模块永远先 INSERT thread）；跨前缀外键本就禁止（S1）。
```

```sql
CREATE TABLE mem_threads (
  id            TEXT PRIMARY KEY,              -- 'thr_' + ulid；同时是控制面 session_id 的取值（§4.1）
  dot_id        TEXT NOT NULL DEFAULT 'dot1',  -- rev2：与 control-plane.md:129 对齐
  channel       TEXT NOT NULL CHECK (channel IN ('web','telegram','cli','email','event','heartbeat')),
  external_ref  TEXT,                          -- 见下方"external_ref 域规则"（rev2）
  title         TEXT,
  origin_task_id TEXT,                          -- event/heartbeat 类 thread 记首个任务 id
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','sealed','purged')),
  pinned        INTEGER NOT NULL DEFAULT 0,    -- 主人 keep（§6.1），永不自动删/sealed
  context_summary           TEXT,
  context_summary_upto_seq  INTEGER NOT NULL DEFAULT 0,
  last_active_at        INTEGER NOT NULL,      -- 任意消息追加时刷新
  last_task_finished_at INTEGER,               -- sealTask 刷新（§6.1 封存锚点，rev2 新增）
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_mem_threads_dot  ON mem_threads(dot_id, last_active_at DESC);
CREATE INDEX idx_mem_threads_task ON mem_threads(origin_task_id) WHERE origin_task_id IS NOT NULL;

-- external_ref 域规则（rev2 修正 §5.3 原注释自相矛盾）：
--   telegram : external_ref = chatId（surfaces.md:234 唯一确定的外部键）→ 幂等生效
--   web      : external_ref = daemon 签发的 web session 键。交互面当前无稳定会话键来源
--              （已记开放问题 Q3）；未定前 web 线程 external_ref = NULL，每次开新 thread。
--   cli      : external_ref = NULL（单主人，无复用需求）
--   event/heartbeat : external_ref 恒 NULL；幂等不靠 UNIQUE(channel,external_ref)，
--              而靠 origin_task_id 唯一（一个事件任务一个 thread）与调用方传入的
--              event_id（首条消息 mem_messages.event_id）判重。
--   → UNIQUE 仅对 (channel, external_ref) 非空者生效，即当前只有 telegram 通道幂等：
CREATE UNIQUE INDEX uq_mem_threads_ext ON mem_threads(channel, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE mem_messages (
  id          TEXT PRIMARY KEY,                -- 'msg_' + ulid
  thread_id   TEXT NOT NULL REFERENCES mem_threads(id) ON DELETE CASCADE,  -- 本模块内 FK，写入顺序自律（同上）
  seq         INTEGER NOT NULL,                -- 每 thread 从 1 单调；同事务 max(seq)+1
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  kind        TEXT NOT NULL CHECK (kind IN
              ('text','tool_call','tool_result','approval_request','approval_verdict',
               'task_start','task_end','memory_note','system_error')),
  content     TEXT NOT NULL,
  task_id     TEXT,                            -- 弱关联控制面 tasks.id，无外键
  event_id    TEXT,                            -- 弱关联事件日志 id；event 触发 thread 首条必填
  token_est   INTEGER NOT NULL,                -- 入库按 chars/3.5 估算
  created_at  INTEGER NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX idx_mem_messages_thread ON mem_messages(thread_id, seq);
CREATE INDEX idx_mem_messages_task   ON mem_messages(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE mem_files_index (                  -- home 的只读镜像索引（§6.2 经桥对账）
  dot_id     TEXT NOT NULL,
  path       TEXT NOT NULL,                    -- HomeRelPath（唯一域，rev2）；
                                               -- 索引范围：MEMORY.md + notes/ + manuals/ 的 *.md；
                                               -- 排除：.archive/**（另表计）、.tmp/**、.dotd/**（执行面保留，绝不入索引）
  area       TEXT NOT NULL CHECK (area IN ('memory','notes','manuals')),  -- rev2：与 MemoryArea 活跃集一致，无 tmp/outbox/archive
  tags       TEXT,                             -- JSON 数组，来自文件头
  title      TEXT,
  size_bytes INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  PRIMARY KEY (dot_id, path)
);

CREATE TABLE mem_maintenance_state (
  key   TEXT PRIMARY KEY,   -- 'compact_due:<dotId>' | 'retention_last_run' | 'index_sync_last'
                            -- | 'payload:<specId>'(§4.5 过渡通道) | 'search_stats'(§6.4 埋点) | 'purge_ledger'
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

FTS5 预留（阶段一不启用；启用条件 §6.4）：

```sql
-- CREATE VIRTUAL TABLE mem_messages_fts USING fts5(content, content='mem_messages', content_rowid='rowid');
```

---

## 6. 会话历史：保留、清理与检索

### 6.1 保留策略（心跳 job `memory-retention` 每日，幂等可重跑）

| 层 | 规则 |
|---|---|
| 活跃 thread | `active/idle` 保留至满足归档条件 |
| 归档 | `last_active_at` >90 天 且 `last_task_finished_at` 距今 >30 天（**rev2：封存判据锚定"任务已终态"而非"聊完"**，字段缺失视为未满足）→ `status='sealed'`；summary 没有则先补，补不动允许无摘要封存 |
| 删除 | `sealed` 且 `last_task_finished_at` >365 天 → 整 thread CASCADE 删；删除前把 `context_summary` 指纹 append 进 `mem_maintenance_state.purge_ledger` |
| 主人特权 | `dotd history keep <threadId>`（rev2 改名，§6.5）→ `pinned=1`，永不过期 |
| 事件/心跳 thread | `last_task_finished_at` 距今 >7 天 → 自动 sealed（rev2：锚点字段已存在，§4.3 sealTask 写入）；**`awaiting_approval` 中的任务因未走完 sealTask，`last_task_finished_at` 为空，天然豁免封存**——审批展示链不失效 |

### 6.2 容量控制（盘小约束）

- `~/.dotd/dotd.db` 软限 **200 MB**：每日检查（`mem_maintenance_state` 游标），超限触发提前归档 + `wal_checkpoint(TRUNCATE)`；硬限 500 MB → 停止写入并进求救（§6.3 路径）。
- WAL：`wal_autocheckpoint=400`（默认），整理任务顺带 checkpoint，防 netfuzz 负载下 WAL 膨胀。
- `mem_files_index` 对账同步器：心跳经 `/fs/ops list` 增量对账（索引范围见表注释，`.dotd/.tmp` 永不入索，rev2）；`.tmp/` 中 mtime >1 天的残留文件由同步器经 `/fs/ops` 清理（rename 失败残骸）。

### 6.3 崩溃恢复顺序（rev2 重写，对齐控制面启动序列）

```
daemon 启动（control-plane.md:417 序列的第 1 步内，schema 迁移之后、HTTP listen 之前）：
  PRAGMA integrity_check
    ├─ 失败 → ①直接向 ~/.dotd/OUTBOX.md 以 fs append 写一条 §3.6 格式 HELP 块
    │          （签名 'db_corrupt'；此路径不依赖 SQLite，也依赖 SQLite——读已断，故只能落文件）
    │        → ②发 bus.breaker/SOS 事件 + 拒绝启动继续（与控制面"迁移失败拒启动"同级别、同流程，
    │          不存在"本模块只读、控制面照写"的半开状态——单库单连接上那不可实现，评审 #10）
    └─ 通过 → 索引对账（§6.2）→ 会话断点扫描（下）
会话断点扫描：
  SELECT … FROM mem_messages m WHERE kind='task_start' AND NOT EXISTS (task_end in same thread after it)
  —— 仅当对应 tasks 行 status ∈ ('running') 时才报"待恢复"交控制面 §7.3 处置；
     status ∈ (done|failed|cancelled) 而无 task_end ⇒ 判定 sealTask 漏调，记 violation 日志行，
     由 retention 任务补写 task_end(kind='task_end', content='{"outcome":"<db status>","backfilled":true}')，
     不再涌入恢复链（rev2：孤儿 task_end 不再随失败率线性累积为"会话断点"噪声）。
     前提：S2' 要求控制面所有终态收口必调 sealTask，残余即漏洞数据。
```

### 6.4 检索、埋点与「何时升级向量库」

- 文件记忆主力检索：容器内 `shell.run grep`（模型）/ `searchHome`（维护）。
- 会话历史：`content LIKE` + thread 时间窗；需要全文时启用 FTS5（一行 DDL，不算上向量库）。
- **埋点归属（rev2 补，评审 #15）**：`MemoryService.searchMessages` 每次调用后向 `mem_maintenance_state` 键 `search_stats` append 计数（滚动 JSON：`{queries, zeroHits, sinceTs}`，保留 14 天窗口，超 64 KB 截旧）。`status()` 汇总输出。**人工纠错记录**：`dotd feedback note "<一句>"`（经 HTTP API 落 daemon，CLI 不直写库，surfaces.md:396）→ 写 `kind='memory_note'`、thread 为专属 `thr_feedback`（channel='cli'）；weekly retention 报告统计其条数。
- 升级信号（任一持续两周）：① `search_stats` 空结果率 >40%；② `thr_feedback` 中"上下文明明有但答不出"类 ≥2 条/周（retention 报告按 tag `recall-miss` 过滤）；③ 全量 rg 扫描 >2s（当前 2 MB 上限不可能触发，触发即政策错）；④ Dot ≥3 且跨 Dot 共享经验成需求。
- 升级选路：sqlite-vec 同库加列优先，**不引入独立向量服务**（违背单进程自主 + 机器约束）。

### 6.5 CLI 子命令空间（rev2：与治理让渡仲裁）

`dotd memory ls/revoke` 已被治理的"审批授权记忆"占用（governance.md:346）——**本模块让出 `dotd memory` 命名空间**，改名：

```
dotd notes ls|show|pin|purge   →  文件记忆管理（§3.4/§3.5/§6.1 的主人入口，经 HTTP API）
dotd history ls|keep|purge     →  会话历史管理（§6.1）
dotd notes compact --dry-run   →  整理预览（§3.5）
（均走 `fetch http://127.0.0.1:7788` + token，CLI 不直写 SQLite，surfaces.md:396）
```

若治理与主人最终希望保留单一 `dotd memory` 入口，由仲裁员裁决后两模块同步改文案，本模块不再自占该名。

---

## 7. 与其他模块的接缝假设

| # | 接缝 | 契约内容 | 对面模块 |
|---|---|---|---|
| S1 | 单库命名空间 | 唯一库 `~/.dotd/dotd.db`（路径与文件名以此为准；control-plane.md:216 的 `db/main.db` 与 memory.md 旧稿 `~/dotd/` 作废）；本模块表 `mem_` 前缀，各模块自取前缀（路由已用 `mr_`/无前缀按定稿文件为准），跨前缀禁止外键；`synchronous=FULL/WAL/busy_timeout` 连接级统一设一次（建议单共享连接，control-plane.md:220 已有此意向），`foreign_keys` 不设全局 ON（§5.3 理由） | 控制面（前缀与连接归属已按其定稿让步） |
| S2 | tasks ↔ thread | `tasks.thread_id` 取值 = `mem_threads.id`；对话路径 `submit` 须带 `threadId`（请求体增字段，待控制面接受，Q1）；事件/心跳路径由 Runner 首步 `memory.create()` 后**自行回写 tasks.thread_id**；`tasks.session_id ≡ thread_id` | 控制面 |
| S2' | sealTask 全覆盖 | 控制面所有使任务进终态的收口（finish、watchdog 回收、背压 kill、优雅关停 abort 落账）必须调 `sealTask(task, outcome)` —— control-plane.md:574 目前只有正常路径，需补（Q1） | 控制面 |
| S3 | 弱关联列 | `mem_messages.task_id/event_id` 存对方主键字符串、无外键，引用完整性由调用方自律 | 控制面/事件入口 |
| S4 | home 卷物理形态 | 接受执行面命名卷 `dot-<dotId>-home:/dot/home`（execution.md:153）；`/dot/home/.dotd/` 为执行面保留，记忆层不索引/不整理；目录规范（§3.2）由本模块定义，物理保障（卷重建后路径内容不变）由执行面定义（execution.md:464 S3） | 执行面 |
| S4' | home FS 桥 | 执行面在 agent-runtime HTTP API（execution.md §5，:9223，Bearer）新增/确认 `POST /fs/ops {op:'read'|'list'|'stat'|'rename', path, target?, dotId}`，与 fs.* 共享路径沙箱；daemon 的注入读取、索引对账、.tmp 清理、归档 rename 全走此桥。**这是本模块唯一对执行面的新增要求** | 执行面 |
| S5 | 工具与限额分层 | 模型只见 `fs.*`/`shell.run` 五工具（注册名逐字同 governance.md:80）；§3.4 策略限额由记忆层在 fs.write 前置检查点强制（`beforeWrite`），物理限额（4MB/8MB/2GB）由执行面兜底，更严者生效（§3.4）；软限 warning 由 Runner 附回工具响应 | 执行面/控制面 |
| S6 | journal 分工 | 工具全量参数/结果只进 journal；`mem_messages` 存 digest+预览；恢复先问 journal（重放与否）再问 messages（聊到哪） | 执行面/控制面 |
| S7 | 审批进线 | 治理审批结果经 `appendSystemMessage(kind='approval_verdict')` 入 thread；审计真源在治理 | 治理 |
| S8 | 低智能任务 | 整理/摘要经 `submit` 投递（载荷通道 §4.5），打标 `track='light'`（对齐 model-router.md:160，旧 `routeHint` 作废）；light 轨候选不可用 → 快速失败，本模块接受跳过 | 控制面/模型路由 |
| S9 | OUTBOX 块格式 | 位置 `~/.dotd/OUTBOX.md`（surfaces.md:378；model-router.md:113 待仲裁 Q2）；追加格式以 model-router.md:526 `## [ts] HELP sig … ---` 为准，本模块轮转按块边界，未收敛 HELP 块（查 `alert_dispatch.resolved_at`）不轮转 | 模型路由/交互面 |
| S10 | 心跳挂载 | `memory-compaction`（每小时）、`memory-retention`（每日）注册为内部任务（track=light，事件类型前缀 `memory.*`，§4.5） | 事件入口/控制面 |
| S11 | 交互面读取 | Web/CLI/Telegram 读会话历史只走 §8 MemoryService（HTTP API 暴露）；`/dot/home` 内容 UI 展示按 surfaces.md:473 属阶段三，届时同样经本模块，不开直读卷路径 | 交互面 |
| S12 | CLI 命名空间 | `dotd memory` 归治理；本模块用 `dotd notes` / `dotd history`（§6.5） | 治理/交互面 |

### 遵守的 CONTEXT 约束清单

- ✅ 两层记忆、起步不上向量库（§3/§5/§6.4）
- ✅ `/dot/home` 任务开始读、结束写（§3.3、§4.2、§4.3）
- ✅ `/dot/home` 为容器卷——按其物理实现（命名卷）适配读取路径（§3.1）
- ✅ SQLite 承载会话历史，单库（§5.3）
- ✅ 完全自主、可迁移、无托管（§2 原则 1）
- ✅ 盘小：home/db 双层容量硬限与回收（§3.4、§6.2）
- ✅ 本地模型"尽力而为"：摘要/整理失败即跳过（§4.4、S8）
- ✅ 崩溃安全 journal 归执行面，本模块补会话维度（§6.3）
- ✅ OUTBOX.md 兜底通道——格式让渡给路由定稿，职责收敛为守门（§3.6）
- ✅ 双轨路由：内部任务走 light 轨（§4.5）
- ✅ 多 Dot 预留（dot_id='dot1' 贯穿）

---

## 8. 对外接口（MemoryService）

```ts
export interface MemoryService {
  // 线程/会话生命周期（session ≡ thread，§4.1）
  openThread(dotId: string, channel: ThreadChannel, opts?: {
    externalRef?: string; title?: string; originTaskId?: string;   // 幂等域见 §5.3 规则：仅 telegram 非空 externalRef 判重
  }): Promise<string>;
  create(): Promise<string>;                       // = openThread('dot1','event')：Runner 首步建 thread（control-plane.md:555 调用形）
  load(sessionId: string): Promise<{ thread: Thread; summary: string|null; messages: Message[] } | null>;  // ≡ getThreadWithMessages（control-plane.md:447/555 调用形）
  get(id: string): ReturnType<MemoryService['load']>;   // sessions.get 别名
  appendMessage(threadId: string, msg: { role: MsgRole; kind: MsgKind; content: string; taskId?: string; eventId?: string }): Promise<{ id: string; seq: number }>;
  appendSystemMessage(threadId: string, msg: { kind: MsgKind; content: string }): Promise<{ id: string; seq: number }>;  // S7 用
  sealThread(threadId: string): Promise<void>;
  updateContextSummary(threadId: string, summary: string, uptoSeq: number): Promise<void>;   // §4.4 回写通道（rev2 补）

  // 注入与重建
  buildContextBundle(dotId: string, taskText: string, budgetTokens: number): Promise<ContextBundle>;  // §4.2（经 /fs/ops 读 home）
  buildSessionReplay(threadId: string, taskId: string, budgetTokens: number): Promise<Message[]>;     // §4.1

  // 收口与限额检查点
  sealTask(task: Task, outcome: 'done'|'failed'|'cancelled', stopReason?: string): Promise<void>;      // S2'
  beforeWrite(dotId: string, path: HomeRelPath, content: string): Promise<MemoryWriteResult>;           // §5.2
  touchManualsLastUsed(dotId: string, paths: HomeRelPath[]): Promise<void>;

  // 查询（交互面唯一入口，S11）
  listThreads(dotId: string, opts: { status?: ThreadStatus; limit: number; cursor?: string }): Promise<ThreadSummary[]>;
  listMessages(threadId: string, opts: { beforeSeq?: number; limit: number }): Promise<Message[]>;
  searchMessages(query: string, opts: { dotId?: string; sinceDays?: number; limit: number }): Promise<MessageHit[]>;  // 内含 §6.4 埋点

  // 维护（幂等，可安全重跑）
  runRetention(now?: number): Promise<RetentionReport>;
  status(): Promise<MemoryStatus>;   // home/db 用量 vs 上限、待整理项、search_stats 窗口（§6.4）、sealTask 违规数
}
```

错误约定：只抛 `MemoryCapacityError`（容量红线，SOS 路径）与 `MemoryCorruptionError`（integrity_check 失败 → 按 §6.3 拒绝启动，不存在模块内"只读半开"）；软限/摘要失败以返回值降级表达，记忆问题不炸主循环。

---

## 9. 开放问题（跨模块仲裁项 + 待主人拍板）

1. **Q1（对控制面）**：`submit` 增 `threadId?` 字段、所有终态收口调 `sealTask`（S2/S2'）。属对方文件的两处小改，本文已按"接受"设计，需控制面确认落地。
2. **Q2（路由/交互面/本模块）**：OUTBOX.md 落点 `~/.dotd/`（surfaces.md:378 + 本稿）vs `/dot/state/`（model-router.md:113）。本文按 `~/.dotd/` 设计——路由在 daemon 进程内，`/dot/state` 是容器视角路径，daemon 崩溃时无容器可写。待路由改一行配置。
3. **Q3（对交互面）**：web 通道无稳定会话键 → 本稿 web thread `external_ref=NULL` 每次新建；若交互面后续引入 web session key 再启用幂等。
4. **笔记写入强制力**：WRITE-SEAL 维持"一轮提醒 + 记 missed"软线，是否要硬到"完成前必须有记忆动作"？默认软（防为写而写的垃圾记忆），主人把"必须沉淀"当第一诉求则改。
5. **sealed→365 天自动删**：盘小约束下的默认；若主人不接受"系统自动删历史"，改为永不删、只封存。
6. **FTS5 启用时机**：一行 DDL 但写放大 ~2x，默认留 §6.4 信号触发。
7. **主人手写记忆共存**：整理允许追加 Pointers，禁止删改主人正文段落；改动过 `dotd notes compact --dry-run` 预览。
8. **CLI 命名终裁**：若主人坚持单一 `dotd memory`，需治理与本模块联动改名（§6.5）。

---

## 10. 评审响应（rev2，逐条）

1. **库路径三处不一致** → 裁决唯一值 `~/.dotd/dotd.db`（§3.1/§5.3/S1）。依据：surfaces.md:5 已定数据目录 `~/.dotd/`，控制面 :220 亦共享单连接；本模块旧稿 `~/dotd/` 作废；control-plane.md:216 `db/main.db` 的 500MB 语义并入本稿 §6.2（db 硬限 500MB 两处数字一致，不冲突，仅名字要统一——S1 已点名该文件作废）。`schema.sql` 汇总位置随之唯一。
2. **PRAGMA 双契约互斥** → 本模块让步统一到 `synchronous=FULL`（§5.3），并删除 §2 原则 3 里"可丢最后 checkpoint 周期"的旧论证；messages 单条 INSERT 在 WAL+FULL 下微秒级，性能代价可忽略。`foreign_keys` 撤销"全局 ON"改为不设、由写入顺序自律（§5.3），避免强制 control-plane.md:136 外键后与 :409 events 90 天 TTL 冲突。S1 中"启动者设一次"改写为"建议单共享连接、连接级参数只设一次"，与 control-plane.md:54 的"各连接各设"说法相比，本稿选择"不制造第二契约"而非争辩 per-connection 理论。
3. **home 挂载形态矛盾** → 全盘接受执行面命名卷（execution.md:153），S4 改写；bind-mount 义务全部删除。daemon 读侧改道 `/fs/ops` 桥（S4'，§3.1 铁律 B）：注入读取、索引对账、.tmp 清理均经 agent-runtime HTTP。与 surfaces.md:473 的冲突消解：UI 展示仍属阶段三，本模块的桥读取只是机器路径，不向交互面暴露 home 内容（S11）。备份/迁移给出 volume tar 方案（§3.1）。
4. **OUTBOX 三说法** → 位置统一 `~/.dotd/OUTBOX.md`（= surfaces.md:378；model-router.md:113 的 `/dot/state/` 列为 Q2 待仲裁，本稿按 daemon 可独立落盘选宿主路径）；格式所有权让渡给 model-router.md:526 的 HELP 块格式（旧 S9 行格式作废）；本模块职责收敛为"按块轮转 + 未收敛块保护（查 alert_dispatch）"（§3.6、S9）。
5. **工具契约与限额双标** → `memory_*` 四工具作废（§5.2）：模型面只有 fs.*/shell.run 五个已注册名，治理规则可逐字对齐；检索走 `shell.run grep`；原子写义务显式化为 `beforeWrite/atomicWrite` 检查点并由 S5 注明 rename 依赖 /fs/ops；限额分层裁决：执行面 4MB/8MB/2GB = 物理兜底，记忆层 §3.4 = 策略强制，更严者生效（§3.4 末段、S5）。
6. **CLI 命名撞车** → 本模块让出 `dotd memory`（治理已定稿，governance.md:346），改 `dotd notes` / `dotd history`（§6.5，S12），并留 Q8 单一入口终裁选项。
7. **thread/session 未收敛** → 裁决 thread ≡ session、同 id（§4.1）；补 `create/load/get/sessions.get` 别名对齐 control-plane.md:447/555 的调用形（§8）；submit 增 `threadId` 字段列为对控制面的要求（Q1），事件路径"先任务后 thread + Runner 回写 tasks.thread_id"通道显式化；§4.1/§6.3 的查询依赖回写完成，恢复链闭合。
8. **WRITE-SEAL 分支缺失** → §4.3 伪码补全三种 outcome 行为（failed/cancelled 不追加提醒轮、只记 missed，并写 `last_task_finished_at`）；S2' 要求控制面所有终态收口调 sealTask（其 :574 缺口列为 Q1）；§6.3 扫描改为只对 status='running' 报断点，终态无 task_end 判 sealTask 漏调、由 retention 回填 `{"backfilled":true}`，孤儿不再淹没恢复链。
9. **整理/摘要投递与回写缺通道** → §4.5 给出双通道：submit.payloadJson（提案）+ title 前缀 `mem:compaction:<specId>` 编码（过渡，spec 存 mem_maintenance_state），不阻塞施工；`routeHint:'low'` 作废，改对齐已定稿 `track='light'`（S8）；§8 补 `updateContextSummary(threadId, summary, uptoSeq)` 回写方法。
10. **崩溃恢复语义** → §6.3 重写：integrity_check 失败 → 不经 SQLite 直接 append 写 `~/.dotd/OUTBOX.md`（HELP 块，签名 db_corrupt）+ 与控制面同级的"拒启动"，删除"本模块只读、对方照写"的不可实现半开状态；检查点并入控制面启动序列第 1 步（HTTP listen 前）。
11. **dot_id 占位值** → 全文统一 `'dot1'`（§2 原则 5、§5.3 DDL `DEFAULT 'dot1'`、§5.1 `create()`、§8），与 control-plane.md:82/129 对齐。
12. **.archive 不可 grep + shell.run 审批歧义** → 归档改"原始 .md 整文件移入 `.archive/` 子目录"，废除 tar（§3.5 动作 2、§2 原则 1）；grep 回溯恢复可行（§3.5 末段加 includeArchive 约定）；整理/归档动作全部走 `/fs/ops` 维护桥而非 shell.run，规避命令执行类工具的 sideEffect 审批（§3.5 引言）。
13. **mem_files_index path 域与范围** → path 域唯一化为 HomeRelPath（§5.1 `HomeRelPath` 类型 + 表注释）；索引范围显式：仅 MEMORY.md+notes+manuals 的 .md，排除 .archive/.tmp/.dotd（§5.3 表注释、§6.2）；`MemoryArea` 删 'tmp'/'outbox'，archive 单列不进活跃索引。
14. **§5.3 注释自相矛盾 / openThread 幂等** → 改写为"external_ref 域规则"代码块：telegram=chatId 幂等生效；event/heartbeat 恒 NULL、幂等靠 origin_task_id/event_id；web/cli NULL；UNIQUE 改为 partial index 只对非空 external_ref 生效（§5.3）。web 无稳定会话键的事实列为 Q3 并指明 surfaces.md:234 现状。
15. **7 天封存锚点 / 埋点归属** → 新增 `last_task_finished_at` 列（§5.3），由 sealTask 写入（§4.3）；awaiting_approval 未终态天然豁免，审批展示链不失效（§6.1）；FTS/检索埋点归属本模块 `searchMessages` 内联写 `mem_maintenance_state.search_stats`（§6.4），人工纠错记录落专属 `thr_feedback` thread（kind='memory_note'，`dotd feedback note` 经 HTTP 入口），retention 周报消费——写者、字段、位置三者指名。
