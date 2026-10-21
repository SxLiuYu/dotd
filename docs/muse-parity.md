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
| 9.1 | 进度推送接真截图 | 两个轮子都有，只差接线 | 见 §4 |
| 9.2 | 审批金额阈值 | 现在只能「一律要批」，缺「超过 ¥500 才问」 | — |
| 9.3 | 活动/回执页 | 数据齐（steps/audit_log），Web UI 缺视图 | — |

---

## 10. 事实边界

**实测**：41 工具、5 条 crontab 全 proactive=0、9 delta/2 final、`sendImage` 存在、
`progress-push` 无 sendImage 调用、27 HTTP 端点、6 Web 视图、无原生工程。

**判断（可能错）**：
- 「接截图是小工量」—— 看了依赖链，没写
- 「IMAP + .ics 覆盖 80%」—— 取决于你要「能用」还是「像原生客户端」
- 「原生 App 不该做」—— 产品判断，不是技术限制

**未验**：真人收到卡片/进度的观感、跨网络稳定性、Muse 的记忆/并行/重试机制（见 `meta-muse.md` §8）。
