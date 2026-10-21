# dotd vs Meta Muse：可行性与清单（2026-10-21 实测）

> 每一个 ✅/❌ 都有本轮实测依据（命令或文件位置），不是读旧文档抄的。
> 旧文档 `muse-gap.md`（10-20）已过期：它说邮件/日历「❌ 没有」，现在都有了。

---

## 一句话结论

| 层面 | 结论 |
|---|---|
| **能力**（能干哪些活） | ✅ **已对齐**，41 个工具，超过 Muse 的 10 个 |
| **形态**（用起来什么感觉） | ⚠️ **一半**：后端几乎齐了，差的是「让它主动」「让它可视」的开关和界面 |
| **多端 App** | ❌ **做不了**（不是难，是这个项目的形态决定的） |

---

## 一、改配置就能开（今天就能用，不用写代码）

| # | 能力 | 现状 | 怎么开 | 实测依据 |
|---|---|---|---|---|
| A1 | **主动找你** | 代码齐、闸门齐、**全部 `proactive=0`** | `UPDATE crontabs SET proactive=1 WHERE id=?` | `db/migrations/170_proactive.sql:45`；5 条 crontab 实测全 0 |
| A2 | **过程可视化（文字）** | 代码齐、**`enabled: false`** | `~/.dotd/config.yml` 的 `ui.progress.enabled: true` | `src/surfaces/progress.ts:36` `DEFAULT_PROGRESS.enabled=false` |
| A3 | **截图随回复推送** | ✅ **已实现**（含飞书上传） | 模型调 `browser.screenshot` 即可 | `channels.ts:368` 手拼 multipart；`screenshot-push.ts` 已接 `daemon.ts:1608` |
| A4 | **Web 控制台** | ✅ **已有**：6 个视图，可构建 | `npm run build:web` + daemon 已在 serve | `web-ui/src/views/` 6 个；`http.ts:424` serve `web-ui/dist` |

**A1/A2 是「已经做完但关着」，不是「没做」。** 这是刻意的安全默认：升级不能自己开始给主人发消息。

---

## 二、要写代码，但确定能做

| # | 能力 | 现状 | 缺什么 | 工量 |
|---|---|---|---|---|
| B1 | **过程可视化改位图** | 现在是 a11y 文字摘要 | 进度推送里改用 `browser.screenshot` + `sendImage`（**两个轮子都造好了**，只差接起来） | 小 |
| B2 | **真流式输出** | 前端已订阅 `chat.delta`、transport/router 都实现了、`daemon.ts:368` 已递 `stream()`；**唯独没有 `publish('chat.delta')` 的生产者** | `src/runner/dot.ts` 里加几行转发 chunk | 小 |
| B3 | **审批粒度（金额阈值）** | 有 `tier: dangerous`，但只能「一律要批」 | 加数值阈值规则（「超过 ¥500 才问」） | 中小 |
| B4 | **活动/回执页** | 数据齐（`steps`、`audit_log`），27 个 API 端点；Web UI 有 `EventsView` | 把现有数据接成一个「它干过什么」的视图 | 小 |

B2 是文档点名的「全仓库投入产出比最高的一个补丁」（`benchmark-agent-capabilities.md:398`）。

---

## 三、要接外部服务，能做但要过审核

| # | 能力 | 为什么现在没有 | 要做的事 | 风险 |
|---|---|---|---|---|
| C1 | **真 Gmail**（不是通用 IMAP） | 现有 `mail.*` 是**通用 IMAP/SMTP**，Gmail 也能用（开应用专用密码）；但没有 Gmail API 那种 OAuth 体验 | Google OAuth + 审核 + token 加密存储 | 中 |
| C2 | **真 Google Calendar** | 现在 `calendar.*` 读写**本地 .ics**，订阅 .ics 只读 | 同上 | 中 |
| C3 | **Stripe 真付款** | 零实现（只有注释里的示例） | 接 Stripe + 支付审批链 | **高**（真钱） |
| C4 | **更多 SaaS**（Notion/Figma…） | `mcp.call` 是通用通道，但没配具体 server | 逐个加 MCP server 配置 | 低 |

**C1/C2 的替代路线已经成立**：通用 IMAP + 本地 .ics 能覆盖「读邮件、起草、记日程」这三件事的 80%，只是首次配置比 OAuth 麻烦（要手填服务器地址和应用专用密码）。

---

## 四、实现不了（或明确不该做）

| # | 能力 | 为什么 |
|---|---|---|
| D1 | **iOS/Android 原生 App** | 零原生工程（`find` 实测无 `.swift`/`.kt`）。**不是技术不行，是定位不同**：dotd 的入口是飞书，飞书本身就是 App。要做等于重做一个前端产品。 |
| D2 | **可爱形象（小熊、可起名）** | 无形象资源、无渲染层。**纯视觉层**，不影响任何能力。Muse 靠可爱降低防备是因为它要收你的信用卡；场景不同，照搬会别扭。 |
| D3 | **Muse Charm 硬件 / 眼镜** | 无此形态。不追。 |
| D4 | **打电话** | Muse 自己也没有。平手，不用做。 |
| D5 | **「让它像 Muse 一样有情绪/人格」** | 这不是能靠改代码「实现」的东西，是产品设计。dotd 现在的 persona 在 `system-prompt.ts` 里，可以调，但那不等于「做到」。 |

---

## 五、如果你只做三件

| 优先级 | 做什么 | 为什么 | 工量 |
|---|---|---|---|
| **P0** | **A1 打开主动推送**（改 1 条 SQL） | 这是 Muse 和 dotd 最本质的差别。不开，dotd 永远只是「你问它答」 | 分钟级 |
| **P1** | **B2 补 `chat.delta` 生产者** | 前端等着、transport 通了、只差几行。投入产出比最高 | 小时级 |
| **P2** | **B1 过程可视化改真截图** | 两个轮子（screenshot + sendImage）都造好了，只差接线 | 小时级 |

三件加起来不到一天，能把「主动找你 + 看着它干活」这两个 Muse 核心体验补齐。

---

## 六、诚实的边界

**我实测确认的**：
工具 41 个、判据全过（mail 41/0、card 21/0、proactive 19/0、progress 27/0、calendar 49/0）、
`proactive=0` × 5、`DEFAULT_PROGRESS.enabled=false`、`sendImage` 已实现、web-ui 6 视图可构建、
无原生工程、`chat.delta` 无生产者、`maxRunningTasks: 1`、Stripe 零实现。

**我的判断（可能错）**：
- 「B1/B2 是小工作量」—— 我看了依赖链，但没真的写
- 「C1/C2 用通用 IMAP + .ics 能覆盖 80%」—— 取决于你要的是「能用」还是「像 Gmail 客户端一样好用」
- 「D1 不该做」—— 这是产品判断，不是技术限制。你要真想做一个 App，技术上当然能做（27 个 API 端点已经在了），只是那是另一个项目

**我不知道的**：
Muse 的记忆机制、并行能力、失败重试、审批粒度（见 `meta-muse.md` §8）。
如果 Muse 在这些地方有你想要的、而 dotd 没有，我这份清单没覆盖到。
