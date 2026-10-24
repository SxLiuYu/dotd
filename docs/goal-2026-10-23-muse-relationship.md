# 工作目标书 2026-10-23（dotd 对标 Muse：相处层）

> 前两层（能力 / 形态）的权威状态见 [`muse-parity.md`](./muse-parity.md)。
> 本文只管第三层：**相处方式**——把 Muse 报道里那五个成本里、不牺牲自托管控制权的部分挪走。
>
> 规则沿用 `goal-2026-10-22.md`：任何「已完成」都要附一条能复现的命令或 `file:line`；
> 没跑过的标「未验」，不许写「应该可以」。

## 0. 判断

`muse-parity.md` §1 的结论是：能力层已对齐（46 工具 → 本轮增至 48），形态层已补齐
（主动推送、进度、截图、审批卡、Web 控制台）。真正没做的是文章讲的**五个成本**。

本轮不新增工具、不改 Runner 引擎，只做呈现层与记忆入口。判定标准不是「功能存在」，
而是每个成本有一条可跑的验收。

## 1. 五个成本与本期动作

| 成本 | 现状 | 本期动作 | 怎么验 |
|---|---|---|---|
| 安装 | `setup` 3 步 + doctor 11 项 | 不改 | `npm run setup -- --check` |
| 选择 | 打开是空白输入框 | M1 动态时间线；M5 主动建议（未做） | `GET /api/feed`、`dotd feed` |
| 学习 | prompt 已隐藏内部名，界面仍会漏工具名 | M2 状态条只说人话（复用 `humanizeTool`） | `GET /api/tasks/:id` 的 `summary` |
| 监看 | `task-view` 是工程师视角 | M2 L1：当前步 / 已用时 / 要不要你 | 同上 |
| 自我介绍 | 无 IDENTITY | M3 人格文件 + `dotd identity`；M4 交接信（未做） | `GET/PUT /api/memory/identity` |

## 2. 任务表（本轮）

| ID | 任务 | 状态 | 写权限范围 | 验收命令 |
|---|---|---|---|---|
| M1 | 动态投影 `feed.ts` + `/api/feed` + `dotd feed` + FeedView | ✅ 单测通过，全量待跑 | `src/surfaces/feed.ts`、`http.ts`(feed)、`daemon.ts`(feedOf)、`cli.ts`(feed)、`web-ui/**`、`tests/surfaces-feed.test.ts` | `node --import tsx --test tests/surfaces-feed.test.ts` |
| M2 | L1 任务摘要 `task-summary.ts` + `/api/tasks/:id.summary` + ChatView 状态条 | ✅ 单测通过，全量待跑 | `src/surfaces/task-summary.ts`、`http.ts`(task_by_id)、`progress.ts`(工具词表)、`web-ui/**`、`tests/surfaces-task-summary.test.ts` | `node --import tsx --test tests/surfaces-task-summary.test.ts` |
| M3 | 人格文件 `IDENTITY.md`：注入 + 读写 API + `dotd identity` + 人格视图 | ✅ 单测通过，全量待跑 | `src/memory/{limits,inject,types,MemoryService}.ts`、`src/shared/contracts.ts`、`src/runner/dot.ts`、`src/surfaces/http.ts`、`daemon.ts`(memPortOf)、`cli.ts`(identity)、`web-ui/**`、`tests/memory-identity.test.ts` | `node --import tsx --test tests/memory-identity.test.ts` |
| M4 | 交接信 + 导入（OpenClaw / ChatGPT 记忆快照） | ⬜ 未开始 | `src/surfaces/memory-import.ts`、`http.ts`、`cli.ts`、`tests/memory-import.test.ts` | 未定 |
| M5 | 主动建议（到审批 / inbox 事件 / 定时 error） | ⬜ 未开始 | `src/surfaces/suggestions.ts`、`http.ts`、`daily-brief.ts`、`web-ui/**`、`tests/surfaces-suggestions.test.ts` | 未定 |

## 3. 设计边界（违反即返工）

1. **只读优先**：M1 是投影，不写库、不推送、不改任务状态；不动 `proactive.ts` / `daily-brief-push.ts`。
2. **不新增表、不加迁移**：所有输入来自已有属主（`tasks` / `approvals` / `crontabs` / `events` / 日历）。
3. **不编 ETA**：没有计划就没有「还剩几步」；只有当前步、已用时、心跳年龄。
4. **人格不塞进 4900 字符的 system prompt**：独立 `sys:identity` 注记，≤1 KB；文件不存在时请求体逐字不变。
5. **默认安静**：动态与建议都是拉取式；任何推送仍归 `proactive` 三道闸。
6. **不露工具名**：L1 / Feed 用人话；`humanizeTool` 查不到时原样返回，不编。

## 4. 明确的非目标

- skill / agent 商店、头像语音、原生 App、付款、共享 agent、Google OAuth、MCP 放宽。
- 不为了「像 Muse」而重做引擎；Muse 是闭源产品，dotd 的差异是**可读、可改、可审计**。

## 5. 完成报告（2026-10-23）

**结论：M1 + M2 + M3 已交付，证据如下。**

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查（根） | `npx tsc --noEmit -p .` | exit 0，0 错误 |
| 类型检查（Web） | `npx tsc --noEmit -p web-ui` | exit 0，0 错误 |
| 全量测试 | `npm test`（并行 4） | **1920 / 1920，fail 0**，约 54s |
| Web 构建 | `npm run build:web` | 成功（27 modules，dist 250.86 kB JS / 10.17 kB CSS） |
| 端到端冒烟 | `node scripts/smoke.mjs`（7788 被现网 daemon 占用，改 7799 跑同一脚本） | **11 / 11 通过**，exit 0 |
| 新增测试 | `surfaces-feed` 10 条 / `surfaces-task-summary` 9 条 / `memory-identity` 5 条 / 路由 4 条 | 全绿 |

**交付内容**

- **M1 动态**：`src/surfaces/feed.ts`（纯投影 + 取数）、`GET /api/feed`、`dotd feed`、Web「动态」视图。
  五类事实（任务 / 审批 / inbox 事件 / 定时 error / 今日日程 + 日历读失败）合成一条时间线，每条带 provenance。
- **M2 L1**：`src/surfaces/task-summary.ts`、`GET /api/tasks/:id` 的 `summary`、ChatView 状态条。
  回答「在干嘛 / 多久了 / 要不要我出手」；在途步不误报卡住；没有计划就不编 ETA。
- **M3 人格**：`IDENTITY.md`（≤1 KB）、`sys:identity` 独立注记、`GET/PUT /api/memory/identity`、
  `dotd identity`、Web「人格」视图。文件不存在时请求体逐字不变。

**未做 / 下一轮**：M4（交接信 + 记忆导入）、M5（主动建议）按目标书预留。
**已知噪声**：首次全量跑时 `tests/temp-cleanup.test.ts` 的全局目录计数出现一次并行误伤
（该文件自己的注释已写明「单跑恒绿、全量偶红」），单跑 7/7、重跑全量 1916/1916 均通过；
不是本轮代码引起，但本轮新增测试文件增加了临时目录 churn，后续可把它改成按本文件名计数。
**未验**：真人观感、真实模型下人格语气的抽验（需要 daemon + 模型凭据）。


---

## 6. P1：执行凭证（2026-10-23，同一轮追加）

**为什么在 M4/M5 之前插这一件**：相处层让 dotd「好上手」，但陌生人凭什么信一个自托管 agent？
内核能力是商品，**「这次任务到底做了什么、能不能对账」**才是 dotd 的差异。P1 不新增工具、不改
Runner，只把已有事实（journal / `exec_calls` / 审批 / `model_call_log` / `audit_log` / `task_results`）
投影成一份可读、可校验、默认不泄密的凭证。

| ID | 任务 | 状态 | 写权限范围 | 验收命令 |
|---|---|---|---|---|
| P1 | `proof.ts` + `GET /api/tasks/:id/proof` + `dotd prove <taskId>` | ✅ 已交付 | `src/surfaces/proof.ts`、`http.ts`(task_proof)、`daemon.ts`(proofOf)、`cli.ts`(prove)、`tests/surfaces-proof.test.ts`、`tests/surfaces-insight-routes.test.ts` | `node --import tsx --test tests/surfaces-proof.test.ts` |

**凭证里有什么**：任务骨架与目标、每一步（类型 / 工具 / 状态 / 耗时 / 审批 id / 哈希对账）、
审批（谁批的、理由、最终参数哈希）、模型调用（端点 / 模型 / 延迟 / token / 是否降级）、审计行、
结果；再加 `bundleHash`——去掉 `generatedAt` 后的稳定哈希，同一 journal 两次导出一致。

**三条刻意的边界**

1. **默认不导出明文参数**：参数/结果只给哈希。要看明文必须 `--args`（`?args=1`），且仍受 journal 截断。
2. **哈希不一致要显形**：`exec_calls` 是执行面记账的权威哈希；journal 被改过（或明文被压缩成 blob 指针）
   时 `hashMatch` 为 `false` / `null`，凭证顶部与 Markdown 里都写出来，不吞。
3. **不冒充公证**：`PROOF.md` 末尾固定写「这是本机 journal 的投影，不是第三方公证；要更强请把
   `bundleHash` 发布到外部」。有本机权限的人仍可改库——凭证只保证**导出时两边对得上**。

**证据（本轮实跑）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查（根） | `npx tsc --noEmit -p .` | exit 0，0 错误 |
| P1 单测 | `node --import tsx --test tests/surfaces-proof.test.ts` | **10 / 10** |
| 路由测试 | `node --import tsx --test tests/surfaces-insight-routes.test.ts` | **22 / 22**（含 proof 503 / 200 / 404 / `?args=1`） |
| 全量测试 | `npm test` | **1932 / 1932，fail 0**，约 53s |
| Web 构建 | `npm run build:web` | 成功（27 modules，250.86 kB JS / 10.17 kB CSS） |
| 端到端冒烟 | 同脚本改 7799（7788 被现网 daemon 占用） | **11 / 11**，exit 0 |
| 真 daemon 凭证 | 冒烟脚本临时副本追加 2 条断言（未入库） | **13 / 13**：`/api/tasks/tk_ev_1/proof` → 200、`bundleHash=71dc4fc38f94…`、3 步、默认无 `argsPreview` |

**未验**：真实 Docker 任务上 `dotd prove` 的观感（冒烟走 stub fleet，但 HTTP 装配与
`exec_calls` 落账是真链路）。**已知缺口**：`bundleHash` 没有外部签名/时间戳，
所以它证明「这份导出与这份 journal 自洽」，不证明「journal 从没被改过」。
