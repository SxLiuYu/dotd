# dotd 对标 Meta Muse：权威状态表（2026-10-21）

> **本文取代 `muse-gap.md`（10-20）与 `muse-parity-checklist.md`（10-21 初稿）。**
> 那两份基于错误的检索得出「B2 流式没生产者」，本轮实测推翻：**流式早就通了**。
> 本文每个结论都附「怎么验的」，可复现。有疑问先复现，再改本文。

---

## 0. 怎么读

- **实测** = 本轮真跑过命令/事件流，附命令
- **静态** = 读代码确认，附文件:行
- **未验** = 判断有依据但没跑，会明说

不写「应该可以」。没验的就标未验。

---

## 1. 总表

| 层面 | 结论 | 依据 |
|---|---|---|
| 能力（能干什么） | ✅ 对齐并超过 | 41 个工具 vs Muse 10 个，见 §2 |
| 主动打扰（Muse 最核心） | ✅ 通，闸门齐 | 代码+DB 全通，仅 `proactive=0`，见 §3 |
| 过程可视 | ⚠️ 文字版可用，位图未接 | `progress-push.ts` 无 `sendImage` 调用，见 §4 |
| 流式输出 | ✅ **已通** | 实测 9 delta / 2 final，见 §5 |
| Web 控制台 | ✅ 有 | 6 视图 + daemon serve，见 §6 |
| 多端 App | ❌ 无原生工程 | 见 §7 |
| 外部账号集成 | ⚠️ 通用替代已有，OAuth 未做 | 见 §8 |

---

## 2. 能力清单（实测）

```bash
node --import tsx -e "..." # 解析 config/tools.yml
# 输出：tools.yml 共 41 个
```

| 组 | 数量 | 工具 |
|---|---|---|
| browser | 5 | open / act / snapshot / screenshot / close |
| mail | 8 | account.add/list/remove, list, read, search, draft, send |
| calendar | 5 | list / conflicts / add / edit / delete |
| fs | 5 | read / write / list / stat / remove |
| github | 3 | notifications / issues / pulls |
| web | 3 | snapshot / read / act |
| schedule | 3 | create / list / remove |
| tool | 3 | list / create / invoke |
| net | 2 | get / post |
| rss / shell / vault / mcp | 各 1 | — |

判据全绿（本轮实跑）：

```
mail-criteria.sh        41 通过 / 0 失败
card-criteria.sh        21 通过 / 0 失败
proactive-criteria.sh   19 通过 / 0 失败
progress-criteria.sh    27 通过 / 0 失败
calendar-criteria.sh    49 通过 / 0 失败   ← 修了 3 条假红判据
```

---

## 3. 主动打扰（Muse 最核心的体验）

**dotd 有，且做了 Muse 没提的三道闸。**

| 层 | 状态 |
|---|---|
| DB 字段 | `crontabs.proactive` / `quiet_hours` / `throttle_hours` / `last_push_at`（`170_proactive.sql:45`） |
| 判定 | `src/surfaces/proactive.ts` 的 `shouldPush()`：开关 → 安静时段 → 节流 |
| 接线 | `control-plane/index.ts:204,247` |
| 当前值 | **5 条 crontab 全部 `proactive=0`**（实测查询） |

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/root/.dotd/dotd.db');
console.log(db.prepare('SELECT proactive,enabled FROM crontabs').all());"
```

**这是「做完但关着」，不是「没做」。** 默认关是刻意的：升级不能自己开始给主人发消息。

设计上比 Muse 更克制的地方：闸门放在**发送之前**而不是任务创建时——
任务照跑（结果进记忆/文件），只是不打扰人。

---

## 4. 过程可视化

| 项 | 状态 |
|---|---|
| 节流判定 | ✅ `progress.ts`：`everyNSteps=3` + `minIntervalMs=90_000` 双阈值 |
| 接线 | ✅ `progress-push.ts` 订阅 `exec.call.finished` |
| 文案 | ✅ `现在：读文件` / `卡在：打开网页` |
| **位图** | ❌ **未接** |

`grep sendImage src/surfaces/progress-push.ts` → **零结果**。
所以进度里只有 `screenOf()` 抽出的文字（"示例站 — example.com"），没有图。

**但两个轮子都已造好**：
- `browser.screenshot` 能出 PNG（实测 `agent-browser screenshot` 产出 90903 字节）
- `FeishuGateway.sendImage()` 已实现（`channels.ts:368` 手拼 multipart，绕开 undici 被飞书拒的问题）
- `screenshot-push.ts` 已把「截图随回复推送」接到 `daemon.ts:1608`

缺的只是：**进度推送时也发图**。见 §9 待办。

---

## 5. 流式输出（本轮纠正的错误认知）

**早先判断「全仓库无 `chat.delta` 生产者」是错的。** 实测：

```bash
curl "http://127.0.0.1:7788/api/stream?topics=chat&token=$TOKEN"  # SSE
# 发一个任务，收到：delta 帧 9 / final 帧 2
```

生产者位置：
- `src/runner/dot.ts` 的 `publishChatDelta()` / `publishChatFinal()`
- `ChatDeltaSink` 做合帧（`streamFlushMs` / `streamFlushChars` 双阈值）
- `streamChatFromEnv()` 默认 **true**（`dot.ts:2789`）
- `daemon.ts:1666` 把 bus 传进 Runner

消费端：`web-ui/src/views/ChatView.tsx` 按 taskId 拼装 delta，`chat.final` 时覆盖。

**注意 `/api/stream` 的鉴权是 query token（`?token=`），不是 Bearer**，用 Bearer 会 401。

---

## 6. Web 控制台

```bash
npm run build:web      # tsc --noEmit && vite build
```

| 视图 | 文件 |
|---|---|
| 对话 | `ChatView.tsx`（含 SSE 增量拼装） |
| 审批 | `ApprovalsView.tsx` |
| 事件 | `EventsView.tsx` |
| 队列 | `QueueView.tsx` |
| 模型 | `ModelsView.tsx` |
| 日志 | `LogsView.tsx` |

daemon 已在 `http.ts:424` serve `web-ui/dist`。HTTP API 共 27 个端点。

---

## 7. 实现不了 / 不该做

| # | 项 | 为什么 |
|---|---|---|
| 7.1 | iOS/Android 原生 App | `find` 实测无 `.swift`/`.kt`/`AndroidManifest.xml`。**不是技术不行**——27 个 API 端点都在，做 App 完全可行，那是另一个项目。dotd 的定位是「在飞书里干活」 |
| 7.2 | 可爱形象（小熊、可起名） | 无形象资源、无渲染层。纯视觉，不影响能力 |
| 7.3 | Muse Charm 硬件 / 眼镜 | 无此形态 |
| 7.4 | 打电话 | Muse 自己也没有 |
| 7.5 | 「人格/情绪」 | 不是改代码能实现的东西。persona 在 `system-prompt.ts` 可调，但那不等于「做到」 |

**7.1 是「不该做」，7.5 是「做不到」**，两者不同，别再混。

---

## 8. 外部账号集成

| 项 | 现状 | 替代方案 |
|---|---|---|
| Gmail | `mail.*` 是**通用 IMAP/SMTP**，不绑服务商 | 开 Gmail 应用专用密码即可用，无需 OAuth 审核 |
| Google Calendar | `calendar.*` 读订阅 .ics（只读）+ 写本地 .ics | 日历客户端导出 .ics 放 `<dataDir>/calendar/` |
| Stripe 付款 | **零实现**（`grep stripe src/` 无结果） | 要接就得处理真钱，风险最高 |
| 更多 SaaS | `mcp.call` 通用通道 | 逐个加 MCP server |

**没有 OAuth 是有意的**：`CalendarService.ts:10` 写明「不直接连 Google/Outlook —— 那需要 OAuth、审核、token 过期」。
通用协议能覆盖 80% 场景，代价是首次配置要手填服务器地址。

---

## 9. 待办（本文档对应的实现项）

| # | 项 | 为什么值得做 | 状态 |
|---|---|---|---|
| 9.1 | 进度推送接真截图 | 两个轮子都有，只差接线 | **已完成**（见 §4.1） |
| 9.2 | 审批金额显示与提醒 | 现在只能「一律要批」，缺「超过 ¥500 才提醒」 | **已完成**（见 §4.2） |
| 9.3 | 活动/回执总览 | 数据齐（steps/tasks），缺「最近干了什么」视图 | **已完成**（见 §4.3） |
| 9.4 | 心跳事件被模型误判 | 定时任务建不出来（真正的 P0 故障） | **已完成**（见 §3.1） |

### 4.1 进度推送接真截图（9.1，2026-10-21 完成）

改了什么：`progress-push` 的 `push: true` 分支新增 `imagePath`，并把截图去重抽成
纯函数 `decideScreen(path, lastSentPath, needsAttention)`（`src/surfaces/progress.ts`）。
顺序刻意固定为**先文字后图片**：文字失败就不发图，避免主人收到一张没有说明的截图。

去重三条规则：无图不发、同上张不发、`needsAttention` 时不查重（该看的时候必须看到）。

验证：`tests/progress.test.ts` 47 断言全过；反向注入两条去重规则各产生 1 个 FAIL。

### 4.2 审批金额显示与提醒（9.2，2026-10-21 完成）

**没有做**「低于阈值自动放行」—— 那会破坏「花钱一律要人批」这条硬边界（GOV §4.1/§4.5：
spend 永不进记忆、永不自动）。做的是**让人更容易看懂自己在批什么**：

- `formatMoney(cents, currency)`：`amountCents` 全链是**分**，卡片原来直接印
  `12500 CNY`，现在印 `125.00 CNY`。零小数币种（JPY/KRW/VND/CLP/ISK/HUF）原样不换算。
- `LARGE_SPEND_WARN_CENTS = 50_000`（500 元）：超过就在卡片上加
  `⚠️ 金额较大，请确认`。
- 裸 `amount` 字段标注「（未标明单位）」，不再假装知道是分还是元。

验证：`tests/feishu-card-money.test.ts` 20 断言全过；反向注入旧的 `String(cents)`
显示产生 2 个 FAIL。

### 4.3 活动/回执总览（9.3，2026-10-21 完成）

新增 `GET /api/activity` + `dotd activity`：回答「它最近都干了什么」。
与 `dotd task <id>` 的分工是「一批任务的结果」vs「一个任务的每一步」。

输出含按状态总数、每个任务的时间/状态/步数，**失败步数只在真有时才显示**
（每行都写「失败 0」等于噪音）。

与 `/api/queue` 的关系：queue 只看在途（queued/running），activity 的主体是已完成的，
两者 SQL 谓词正好互补。

验证：`tests/activity-endpoint.test.ts` 20 断言全过；limit 三向夹逼实测
（999→100、abc→20、0→1）。

### 3.1 心跳事件被模型误判（9.4，2026-10-21 修复的 P0 故障）

**这是本轮发现的最严重问题**：定时任务**从来建不出来**。

链路本应是：`crontabs` 到期 → `fireHeartbeat` → `ingestEvent` → 匹配 → 建任务。
实测发现事件 100% 落在 `status='inbox'`，从不产生 `event_decisions`。

根因：`config/event-rules.yml` 阶段一默认 `rules: []`（有意留空，规则写错会误建任务），
于是所有事件都落到**模型层**判「要不要建任务」。对 http/file 这类事件这没错，
但 heartbeat 的 payload 里已经带着 `title`/`prompt`/`proactive` ——
「该不该建任务」在调度器那步就答完了，让模型重判一遍本身就是错的。

而模型在实测中给出了两种都不是分类结果的回答：
- 把 `payload.prompt`（`"Reply with exactly: PROACTIVE-PROBE-OK"`）当成要它执行的指令，
  直接回了 `PROACTIVE-PROBE-OK`；
- 强化 system prompt 后转为过度防御，回 `"I can't act on that message"`。

两者都让 `parseJsonOnce` 返回 null → 落 inbox → 任务永不创建。

修法：`match.ts` 新增 `heartbeatDecision()`，heartbeat 事件**确定性短路**，
按 payload 直接建任务（`via='rule'`, `confidence=1.0`）。规则层仍优先，
主人可以在 `event-rules.yml` 写规则覆盖。payload 缺 `prompt` 或不是对象时退回原路径。

验证：`tests/heartbeat-decision.test.ts` 18 断言全过。反向注入删掉短路后立即
`Error: heartbeat 不该调模型层`，栈直指 `matchByLlm`；恢复后 18/18 绿。
端到端实测：`ct_a1v3` → `ev13 matched (via=rule, confidence=1)` → `tk_ev_13 done`
→ 飞书实收 `PROACTIVE-PROBE-OK`（`surf_outbound_log` id 808/809，`ok=1`）。

---

## 10. 事实边界

**实测**（2026-10-21 更新）：41 工具、9 delta/2 final、`sendImage` 存在、
28 HTTP 端点（新增 `/api/activity`）、6 Web 视图、无原生工程、
心跳事件经确定性短路建任务并实收飞书推送。

**判断（可能错）**：
- 「接截图是小工量」—— 看了依赖链，没写
- 「IMAP + .ics 覆盖 80%」—— 取决于你要「能用」还是「像原生客户端」
- 「原生 App 不该做」—— 产品判断，不是技术限制

**未验**：真人收到卡片/进度的观感、跨网络稳定性、Muse 的记忆/并行/重试机制（见 `meta-muse.md` §8）。
