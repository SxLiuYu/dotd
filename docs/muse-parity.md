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
| 过程可视 | ✅ 文字 + 位图，且已启用 | 启动日志「已启用（每 3 步 / 至少隔 90 秒）」，见 §4 |
| 流式输出 | ✅ **已通** | 实测 9 delta / 2 final，见 §5 |
| Web 控制台 | ✅ 有 | 6 视图 + daemon serve，见 §6 |
| 多端 App | ❌ 无原生工程 | 见 §7 |
| 外部账号集成 | ⚠️ 通用替代已有，OAuth 未做 | 见 §8 |
| **付款 / 下单** | ❌ **不支持（决定，不是待办）** | dotd 零支付通道；`shop.checkout` 不是可调用工具。见 §7.6 |

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
| 当前值 | **2026-10-22 实测：现存 4 条全部 `enabled=1` 且 `proactive=1`**（其中「早间日程提醒」throttle=20h）。2026-10-21 那版写的是「1 条开、其余 4 条 0」，已被本轮改动超过：proactive 陆续打开，且 A5 按 id 删掉两条（重复的「早间喝水提醒」`proactive=0` 与测试残留「一次性验证」`enabled=0`）。**这行数字必然再变，以上面那条 SQL 当场查为准** |
| 消费端 | `feishu-outbound.ts` 的 `shouldAnnounce()`（2026-10-21 补，此前判定无人读） |

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/root/.dotd/dotd.db');
console.log(db.prepare('SELECT proactive,enabled FROM crontabs').all());"
```

**这是「做完但开着」，不再是「关着」。** 默认关仍是刻意的（升级不能自己开始发消息），
但本轮已对一条真实任务打开，并实测三道闸逐个生效。

### 3.2 三道闸实测（2026-10-21）

同刻触发三条，只差一道闸：

| crontab | 配置 | `last_fire_status` | `last_push_at` | 飞书实收 |
|---|---|---|---|---|
| 安静时段 | `quiet_hours=00:00-23:59` | **`skipped_quiet`** | null | 无 |
| 节流 | `throttle_hours=99` 且刚推过 | `fired` | 未更新（保持旧值） | 无 |
| 对照 | 全放开 | `fired` | **已更新** | **Q-OK** |

两条结论值得记住：

1. **安静时段在调度层就拦住**（`last_fire_status=skipped_quiet`，任务根本没建），
   而**节流让任务照跑、只是不推**（`fired` + 任务 done，无出站）。
   这个区别是有意的：安静时段是"别吵我"，节流是"说过一次了"。
2. 任务 `done` 与是否推送**完全解耦**。上一轮修的缺陷正是这里 ——
   此前 `taskStateText` 对所有任务结束都回复，不看 `proactive`，
   导致「关着的任务照样天天打扰」（`surf_outbound_log` 811/812 两条同刻推送）。

设计上比 Muse 更克制的地方：闸门放在**发送之前**而不是任务创建时——
任务照跑（结果进记忆/文件），只是不打扰人。

---

## 4. 过程可视化

| 项 | 状态 |
|---|---|
| 节流判定 | ✅ `progress.ts`：`everyNSteps=3` + `minIntervalMs=90_000` 双阈值 |
| 接线 | ✅ `progress-push.ts` 订阅 `exec.call.finished` |
| 文案 | ✅ `现在：读文件` / `卡在：打开网页` |
| **位图** | ✅ 已接（9.1） |
| **启用** | ✅ 已开启（2026-10-21，见 §4.4） |

（历史记录：本节早先写的是「未接」。9.1 已把 `imagePath` 接进 `push: true` 分支，
`grep sendImage src/surfaces/progress-push.ts` 现在有结果。保留这段是为了标明
结论变过，不是一直如此。）

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
| 7.6 | **付款 / 下单（Stripe 一类支付通道）** | **本轮定为「不支持」**，不是待办。理由与边界见 §7.6 与 §8 |

**7.1 是「不该做」，7.5 是「做不到」，7.6 是「决定不做」**，三者不同，别再混。

### 7.6 付款能力边界（2026-10-22 定案，任务 B4）

**结论：dotd 不支持付款，也不把「接 Stripe」留作待办。** 这是一个决定，不是进度落后。

理由两条：

1. **真钱风险最高**：一旦接通，「说一句就下单」这类体验的错误成本是真金白银，且扣款不可撤销；
   本轮没有任何机制能在扣款之前替主人兜住判断错误。
2. **没有支付通道**：实跑 `grep -rni stripe src/` → **0 命中**（2026-10-22）。接 Stripe 需要商户资质与
   API key，是「另一个项目」的工程量，不是补几行代码。

**关于 `shop.checkout` 的真实语义（别照工具名猜，也别照旧文档猜）**：

它**不是一个可以调用的工具**。2026-10-22 实测三件事：

- `grep -rni shop src/` → **0 命中**：运行代码里没有这个名字，模型的工具列表里不会出现它，
  因此也谈不上「被主人误认为能付钱」的技术入口。
- `config/tools.yml:122-126`：整段以 `#` **注释掉**的**形状模板**，注释头原话（:120）是
  「阶段二接入支付/下单类工具时按此形状补条目（含 spendParams.required）」。其档位写的是
  **`spend`**，不是 `dangerous`。同文件 :119 还写着「阶段一工具词表（§9.1/M5）**无 spend 档工具**；
  购物走 `browser.act` 由 review 承接」。
- `tests/runner-main.test.ts:86`、`tests/governance-state-machine.test.ts:53`：**测试夹具里的假工具名**，
  用来验证「spend 档一律开人工审批单」这条策略（`governance-state-machine.test.ts:47` 的测试名），
  不代表存在支付能力。

实测档位现状（可复现）：

- active 的 `tier: spend` 条目：**0 个**（`grep -nE "^[[:space:]]*tier: spend" config/tools.yml` 无输出）。
- active 的 `tier: dangerous` 条目只有 5 个，都不是付款：`fs.remove` / `mcp.call` / `tool.create` /
  `tool.invoke` / `mail.send`。

所以「dotd 有个 `shop.checkout` 工具挂在 dangerous 档 ⇒ 主人以为能付钱」这条推断**不成立**：
该名字既不在工具白名单（未注释部分）里，也不是 dangerous 档，模型根本看不到它。
真正会让人误会的是 §8 旧行只写了「零实现」而没写「不支持」——读的人把它当成「还没做、以后会做」。
本节把它改成一个明确的**决定**。

**「购物」在 dotd 里现在到底是什么**：走 `browser.act` / `web.act` 在页面上点击与填表
（`config/tools.yml:204` 原话：「危险动作由 spend 档把关」——而 spend 档当前为空）。
即 dotd **能**把商品查到结算页、把要买的东西和价格报给主人，**不能**完成最后一步付款。

**这条边界写在哪、靠什么守住**（三处一致）：

1. 本节 + §8 表格行：文档层面的结论。
2. `src/runner/system-prompt.ts`「# 干活的节奏」段（2026-10-22 新增一行）：让模型自己知道不能付款、
   别去页面上凑支付流程、别答「我来下单」。
3. 判据：**没有** `scripts/regress/` 判据守着这条边界。实跑核对（2026-10-22）：
   `grep -rni stripe scripts/regress/` → 0 命中；`grep -rn '付款\|下单\|支付\|扣款' scripts/regress/` → 0 命中；
   `grep -rni shop scripts/regress/` → 2 命中，但**与付款无关** —— 都只是 `progress-criteria.sh:146,168`
   里当作进度推送样例的假想域名 `shop.example.com`（测的是「browser.open 的标题+域名怎么翻成人话」）。
   `tests/` 里也没有断言这条新提示词行（`grep -rn 你不能付款 tests/ scripts/` → 0 命中）。
   结论：这条边界靠**文档 + 系统提示词**守住，不是靠代码拦住一个并不存在的付款调用；
   `SYSTEM_PROMPT_BUDGET` 那条测试（`tests/runner-tool-catalog.test.ts:267`）只保证提示词不超长，
   **不保证**付款边界这句话还在。（`docs/goal-2026-10-22.md` 不在 cleanup 的写权限范围内
   —— 见该文件 §2 任务表里 B4 一行写的授权范围。这条「边界靠文档+提示词而非代码守住」的结论
   已随任务 B4 回报 lead，由其写进交付段。）

---

## 8. 外部账号集成

| 项 | 现状 | 替代方案 |
|---|---|---|
| Gmail | `mail.*` 是**通用 IMAP/SMTP**，不绑服务商 | 开 Gmail 应用专用密码即可用，无需 OAuth 审核 |
| Google Calendar | `calendar.*` 读订阅 .ics（只读）+ 写本地 .ics | 日历客户端导出 .ics 放 `<dataDir>/calendar/` |
| **付款 / Stripe** | **不支持（2026-10-22 定案，非待办）**：`grep -rni stripe src/` → 0 命中；`shop.checkout` 只是 `config/tools.yml:122` 里**被注释掉的模板**与测试夹具名，**不是可调用工具**（详见 §7.6） | 不接。要买东西由主人自己付：dotd 可查到结算页并报价，最后一步不代付 |
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
| 9.5 | 金额阈值规则谓词 | 清单 B3「超过 ¥500 才问」 | **已完成**（受限形式，见 §4.4） |
| 9.6 | 开启 ui.progress | 目标要求，且挖出一个配置缩进缺陷 | **已完成**（见 §4.4） |

### 4.1 进度推送接真截图（9.1，2026-10-21 完成）

改了什么：`progress-push` 的 `push: true` 分支新增 `imagePath`，并把截图去重抽成
纯函数 `decideScreen(path, lastSentPath, needsAttention)`（`src/surfaces/progress.ts`）。
顺序刻意固定为**先文字后图片**：文字失败就不发图，避免主人收到一张没有说明的截图。

去重三条规则：无图不发、同上张不发、`needsAttention` 时不查重（该看的时候必须看到）。

验证：`tests/progress.test.ts` 47 断言全过；反向注入两条去重规则各产生 1 个 FAIL。

### 4.1b 截图其实一张都没发出去过（2026-10-21 实机发现并修复）

9.1 把 `imagePath` 接进 `push: true` 分支后，代码看着齐了：
`readHomeFile` 读图、`sendImage` 发图、`decideScreen` 去重。测试也 47 条全过。

**但真跑一遍才发现一张图都没发出去。**

实测：发一个 `browser.open` + `browser.screenshot` 的任务，
进度推了 7 次（日志有 7 行「推了进度」），**零行「随进度发了截图」**，
也没有任何「读图失败」——因为 `sendShot()` 压根没被调用。

**根因**：`screenshotPathOf()` 只认 `{path}` 与 `{result:{path}}`，
而 `steps.result_json` 实际存的是：

```json
{"output":"{\"path\":\"/dot/home/screenshots/shot-mvhqow41.png\",\"bytes\":67006}"}
```

工具输出先被字符串化、又包了一层。于是解析**永远返回 null**，
`decideScreen(null, ...)` 返回 null，附图分支静默跳过。
截图在容器里造得出来（67006 字节 PNG，`steps.result_json` 里有路径），
但从来没送到主人手上。

**为什么单测没抓到**：`tests/progress.test.ts` 测的是 `decideScreen` 的纯逻辑，
输入是我手写的 `'/dot/home/screenshots/x.png'`。真实形状根本没进测试视野。
这是「纯函数测对了，接线处的数据形状错了」的典型。

**修法**：`screenshotPathOf` 三种形状都认，并递归解 `output`（是 JSON 再解一层），
深度上限 3 防炸栈。解不出就返回 null，绝不拼路径。

**验证**：

```
$ grep progress /tmp/dotd-wsl.log
[dotd] [progress] tk_mvhxmalvwkgtab 推了进度（interval，3 步）
[dotd] [progress] tk_mvhxmalvwkgtab 随进度发了截图（67006B）   ← 此前从未出现过
```

`tests/screenshot-path.test.ts` 14 断言，第一条用的就是**生产库捞出来的原文**，
不是我构造的形状。反向注入（退回旧实现）→ 3 FAIL / rc=1；恢复 → 0 FAIL。

**顺带说明节流参数**：正式配置是 `every_n_steps: 3` + `min_interval_ms: 90000`。
一个 20 秒跑完的任务只会在第 1 步推一次，那时还没截图 —— 所以即使修好解析，
短任务也可能一次图都赶不上。要验证链路必须临时把两个阈值调低
（本次实测用 `1` / `0`，验完已恢复）。**这是节流在按设计工作，不是 bug**，
但意味着「长任务才有过程图」，值得知道。

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

### 4.4 开启进度推送（9.6，2026-10-21）

目标只是「把 `progress.enabled` 打开」，但打开的过程挖出一个**真缺陷**。

**症状**：无论怎么改 `enabled`，启动日志永远是
`[progress] 过程可视化未启用（需要 enabled + sender + chatId 三者齐备）`。

**根因**：`_config_src.yml` 里 `progress:` 的缩进是 6/8 空格（应为 2/4），
于是它被 YAML 解析成 `ui.stream_deltas` 的**子节点**：

```yaml
  ui:
    stream_deltas: true
      progress:          # ← 6 空格，挂错层了
        enabled: false
```

结果 `surfaces.progress` 恒为 `undefined`，由 zod 的
`.default({ enabled: false, ... })` 兜底 —— 所以**看起来配了，实际从没生效过**。
而 `scripts/wsl-daemon.sh:37` 每次启动都 `cp _config_src.yml ~/.dotd/config.yml`，
这个错误配置一直跟着跑，谁改 `~/.dotd/config.yml` 都会被覆盖回去。

**修法**：修正 `_config_src.yml` 缩进（2/4 空格），`config/dotd.yml` 的
`progress.enabled` 置 `true`。

**验证**：

```
$ grep progress /tmp/dotd-wsl.log
[dotd] [progress] 过程可视化已启用（每 3 步 / 至少隔 90 秒）
```

判据是**清空日志后重启**再看 —— 旧日志里那条「未启用」是历史残留，
不清理会误判成没修好（本轮踩过这个坑）。

顺带记一个排查教训：`loadSurfacesConfig` 明明返回 `enabled:true`，
但 daemon 里探针打印 `enabled:false`。原因是 daemon 启动于 `17:41:27`，
而我在 `17:41:28` 才写文件 —— 差 1 秒，它读的是旧内容。
**改配置后必须确认新进程的启动时间晚于文件 mtime**，否则验的是旧进程。

### 4.7 审批卡片点了没反应（2026-10-21，排查中）

主人三次反馈「点了没反应」。已确认的事实，全部有日志或实测支撑：

**事实一：点击确实到了进程。** 每次点击日志都有
`飞书长连接收到事件 card.action.trigger`，event_id 各不相同
（`86d44f01…` / `fa127df9…` / `926fb3a5…`）。

**事实二：`daemon.ts` 装配 `startFeishuWs()` 时没传 `approval`。**
于是每次点击落到 `handleFeishuCallback` 的：

```ts
if (deps.approval === undefined) {
  return { httpStatus: 200, body: { ignored: true, reason: 'approval_not_wired' } };
}
```

静默丢弃。**已修**：接上 GOV 的 `decide()`，并让卡片落定后改文案。

**事实三：`action.value` 被编码了两层。** 真实载荷（从日志抓的）：

```json
"action": { "value": "\"{\\\"kind\\\":\\\"approval\\\",\\\"approvalId\\\":134,\\\"verdict\\\":\\\"approve\\\"}\"", "tag": "button" }
```

`parseCardAction` 只解一层，解出来还是字符串 → `typeof obj !== 'object'` →
`return null` → 判成 `ignore` → 又是一次静默丢弃。**已修**：最多解三层。
修后用真实载荷复现：

```
改前：'"{\"kind\":\"approval\",...}"' → parsed: null      ← 丢在这里
改后：'"{\"kind\":\"approval\",...}"' → {kind:'approval', approvalId:134, verdict:'approve'} ✓
```

**事实四：整条判别链现在是通的。** 用抓到的真实载荷走一遍：

```
envelope.event keys: [schema, operator, action, host, context]
decision: {"kind":"card_action","approvalId":134,"verdict":"reject",
           "chatId":"oc_e764f9…","operatorId":"ou_028f4e…"}
```

**但仍未落定。** `surf_inbound_seen` 里有这两个 event_id（说明进了
`handleFeishuCallback`），`approvals#134` 却还是 `pending`。

**下一步（正在做）**：`route()` 里只对 `error` / `taskId` 两种结果打日志，
`ignored` / `decided` 都静默 —— 所以"决策那一步返回了什么"完全看不见。
已加一行覆盖所有分支的结果日志，等一次真实点击暴露真实返回值，
不再靠推断改代码。

**这里我要承认一个方法错误**：前面几轮我是「先改代码，再看效果」，
于是每轮只能确认「又没成」。正确顺序是**先让失败可见**（加日志），
拿到真实返回值，再动手改。守则里写着这一条，我这几轮做反了。

#### 已解决（2026-10-21 当天闭环）

三个缺陷，逐个实测确认：

| # | 缺陷 | 证据 | 修法 |
|---|------|------|------|
| 1 | `startFeishuWs()` 没传 `approval` | 日志 `{"ignored":true,"reason":"approval_not_wired"}` | `daemon.ts` 补上，映射 `approve`→`approve_once` |
| 2 | `feishu-ws.ts` 手工挑字段时漏传 `approval` | 同上（改完 #1 仍复现，是我自己引入的） | 改为透传 `deps.approval` |
| 3 | `action.value` 双重编码 | `parseCardAction` 只解一层 → `null` → 判 `ignore` | 最多解三层 |

**实测闭环**（不是推断）：

```
点击 #134 → 日志 {"decided":true,"approvalId":134,"status":"approved"}
            approvals#134: pending → executing（decided_by=web）
            任务 tk_mvhygznnjpvy9g: awaiting_approval → running → done
```

**第四个缺陷（面更大，主人没问，查出来的）**：
`resolveExecution()` 定义在 `gate.ts:1508`、从 `governance/index.ts` 导出，
**全项目无人调用**。后果：`claim()` 把审批推进到 `executing` 就再没人管，
**库里 126 条审批全停在 `executing`，一条终态都没有**；而 `gate.ts:372`
对 `executing` 是 `deny('execution in flight')` —— 同一张单子永久不可用。

修法：`GovernanceApi` 增 `resolveExecution`，`daemon.ts` 接线，
Runner 在审批续跑的工具执行完之后回报（失败只记日志，不让已拿到的结果作废）。

实测：

```
API 裁决 #136 → resolved approved → 执行完
approvals#136: pending → approved → executed ✓
任务 tk_mvhzwsn4f4zoa6 → done
改前同位置：停在 executing（反向注入复现，测试 FAIL「claim 后应为 executing…actual 'executing'」）
```

反向注入验证：摘掉 `resolveExecution` 调用，`tests/runner-main.test.ts`
立刻失败（`actual: 'executing'`）；恢复后 14/14 通过。

**顺带修的方法问题**：`route()` 只对 `error`/`taskId` 打日志，
`ignored`/`decided` 全静默 —— 这正是连续三轮"看不出卡在哪"的直接原因。
现在任何结果都落一行。

### 4.6 飞书消息精简（2026-10-21，按主人要求）

主人原话：「飞书的消息精简一下，推送的太多了」。**先量再改**，24 小时实测：

| 口径 | 数量 |
|---|---|
| 出站总数 | 56 条 = 12 张审批卡 + 44 条回复 |
| 回复里我造的测试消息 | 13 条（`PROACTIVE-PROBE-OK` / `GATE-ON` / `Q-OK` …） |
| 回复里真实对话 | 31 条，其中 **28 条顶到 200 字预览上限** |
| 库内 assistant 正文最长 | 1364 字；超 500 字的 111 条 |
| 任务来源 | 50 个：**web 32 / event 11 / feishu 7** |
| 但这些任务的回复 | **44 条全部推到飞书** |

结论：问题不在条数，在**三处冗余**，各配一条确定性规则（都不依赖模型配合）：

**一、Web 发起的任务不再镜像到飞书。**
32/50 任务来自 Web，人在电脑前看结果，手机又原样收一遍 —— 那是重复不是通知。
新增 `surfaces.feishu.mirror_web_to_feishu`（默认 `false`）+
`shouldMirrorToFeishu()`。飞书里说的（`channel=feishu`）照常回，定时任务
（`channel=event`）仍走 `shouldAnnounce` 三道闸。

实测：

```
$ 从 Web 发 "Reply with exactly: WEB-NO-MIRROR"
$ tail /tmp/dotd-wsl.log
[dotd] 飞书出站跳过：tk_mvhybeunbfmd65 来自 Web 会话（结果在 Web 看，不镜像到飞书）
$ 查 surf_outbound_log WHERE id>820 → 无新记录 ✓
```

**二、长文折叠：上限 3800 → 600 字并指路。**
`clipForFeishu()` 在段落/句号处断句（找不到边界才硬切），
尾巴写「还有 N 字，完整内容见 Web 会话，或用 `dotd task <id> --verbose` 查看」。
**正文一个字都不丢**，完整内容在 `mem_messages` 里。

**三、无信息量回复静音。**
数据库里那 13 条 `I don't have browser.open` 这类自我否定，**不是回答，是报错**。
`isLowValueReply()` 命中就不发飞书，只落库。

判据刻意保守，两条红线：

- 只认「整条就是一句否认」。**有转折词（但/不过/然而/however）就不静音** ——
  因为那说明模型在否认之后补了信息。这条正是测试逼出来的：
  第一版拿整条匹配，把「我无法连接那个站点，**但**我查了缓存，标题是 Example」
  也吞了，26 条用例里挂了 1 条，回头改的。
- 超 200 字的回复一律不静音：能写长说明有内容。

**验证**：`tests/feishu-message-budget.test.ts` 26 断言全过；
反向注入三项全部成立 ——

```
去掉转折判据     → 1 FAIL / rc=1（漏杀那条被抓住）
上限改回 3800    → 5 FAIL / rc=1
退回"永远镜像"   → 1 FAIL / rc=1
恢复后           → 0 FAIL / rc=0
```

旧的 `tests/surfaces-feishu-outbound.test.ts` 断言的是 `repeat(3800)`，
编码了旧行为，已按新行为改写（前 600 字保留 + 有「还有」+ 有 `dotd task` + 总长 < 700）。

### 4.5 金额阈值规则（9.5，2026-10-21 的受限实现）

清单原话是「加数值阈值规则（"超过 ¥500 才问"）」，字面读 = **低于阈值不问**。

**这条读法与项目自己的硬约束冲突**：

- GOV §2.1 表格：`spend | approve | 一律人工审批；记忆规则对其永不生效`；
- GOV §2.6：`rules.yml` **只能收紧**（降档在加载时拒绝并告警）。

`rules.yml` 的 `decision` 只有 `allow/review/approve/deny`，命中后只能升级不能降级。
所以「加个谓词就能免审批花钱」在本架构里**结构上做不到** —— 这不是没实现，是设计上拒绝。

**实现的是阈值的可用形式**：新增谓词 `match.amountAtLeast`（单位**分**）。

```yaml
rules:
  - match:
      tool: shop.checkout
      amountAtLeast: 50000        # ≥ ¥500
    decision: approve             # 必问
    reason: "单笔 500 元以上必须人工确认"
```

命中条件 `amountCents >= amountAtLeast`。因为命中后只能转 `approve`/`deny`，
这个谓词**不可能**产生「低于阈值放行」。写 `decision: allow` 配它会被拒：

```
rules.yml 条目 {"tool":"shop.buy","amountAtLeast":50000} 试图把 approve 放宽为 allow，已拒绝
```

**验证**：`tests/amount-threshold-rule.test.ts` 10 断言，两个方向都钉住：

- 能达到：≥N 必问、≥N 直接拒、坏值（0/负数/小数）被 zod 拒绝；
- 做不到：`spend + allow`、`spend + review` 均被拒并给出 `rule_not_stricter`。

实测把规则写进真实 `config/rules.yml`：`loadCatalog` 接受（accepted=1，无告警），
`match` 保留 `{"tool":"fs.write","amountAtLeast":50000}`。

**当前限制**：阶段一 `config/tools.yml` **没有登记任何 spend 档工具**
（`shop.checkout` 是注释掉的结构示例，GOV §9.1/M5 阶段一工具词表无 spend 项）。
所以这个谓词现在可用于 `fs.write` 等收紧场景，真正用在花钱上要等
阶段二接入支付类工具 —— **那时不需要改代码，只加配置**。

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

### 4.8 截图从来没随进度发出去过（2026-10-21，已修并实测）

**发现过程**：主人问「meta muse 功能都满足了吗」。我没有读文档，逐项实跑核对，
结果在一片"已完成"里发现了这个。

#### 表面症状

§4.1 原来把「进度推送接真截图」标为**已完成**。但实测一个普通任务：

```
[progress] tk_mvi2ruzz4pd33b 推了进度（start，1 步）   ← 唯一的推送
```

`browser.screenshot` 成功了 **2 次**，可那次推送发生在第 1 步 ——
**截图还没产生**。按日常配置（每 3 步 / 至少隔 90 秒），
一个 20 秒的任务永远轮不到"带图的那一次"。

结论：**功能是好的，但主人从没在手机上看过一张截图。**
§4.1 标"已验证"用的是临时把阈值调到 1 步 / 0 秒，**不代表日常配置下能用**。
这是拿"能跑通"当"已满足"的典型误判。

#### 三个叠加的缺陷

| # | 缺陷 | 后果 |
|---|------|------|
| 1 | 新截图不越过 `every_n_steps` / `min_interval` 节流 | 短任务永远推不到带图那次 |
| 2 | `decideScreen` 在 `needsAttention` 时**无条件**返回同一张图 | 同一张图几秒内发两遍 |
| 3 | `st.lastPushAt` / `lastImagePath` 在 `await send()` **之后**才更新 | 并发的两个总线事件都读到旧值 → 连推两条文字 + 连发两张图 |

#### 修法（主人选方案 1：截图成功时立刻推）

1. `ProgressInput` 加 `freshShot`；`decideProgress` 在 `too_few_steps` **之前**
   判定它，新截图越过步数与时间节流，`reason` 标 `shot`
2. `decideScreen` 去掉 attention 的无条件放行 —— **attention 要保证的是
   "文字一定到达"，不是"图一定重发"**；同一张 PNG 看第二遍没有新信息
3. 状态**先占位再 await**，失败回滚（不能"发失败也算推过"，否则最该看的那条永久丢）

#### 顺带修的两个可观测性缺口

- `progress-push` 原来**完全不写持久台账**（只写日志，日志每次重启被截断）。
  我因此误判过一次："`surf_outbound_log` 里只有 `approval_card`/`task_reply`，
  就以为从没发过图"。现在 `sendShot` 写 `kind='progress_image'`。
- 静默分支（`too_few_steps` / `too_soon`）原来不打日志，排查时看不出
  "是被节流还是根本没走到"。现在每个分支都落一行。

#### 还发现跨模块重复

`progress-push`（过程中）和 `screenshot-push`（任务结束时重发最近 3 张）
是两条独立路径，同一张图会发两遍。用 `surf_outbound_log` 当共享台账去重：

```
[screenshot-push] 跳过（进度推送已经发过）/dot/home/screenshots/shot-mvi3lqh7.png
[screenshot-push] 跳过（进度推送已经发过）/dot/home/screenshots/shot-mvi3ln58.png
```

判据是 `kind='progress_image' AND ok=1` —— **发失败的不算发过**，仍要重试。

#### 实测证据（三轮，每轮都暴露一个新问题）

| 轮次 | 台账记录 | 去重后 | 结论 |
|---|---|---|---|
| 修复前 | 5 条 | 4 张 | 重复 1 张 |
| 只补跨模块去重 | 2 条 | 1 张 | 仍有重复（竞态） |
| **修竞态 + `decideScreen`** | **4 条** | **4 张** | **零重复** |

日志（`tk_mvi3qf2yiblohu`）—— 注意 `跳过(too_few_steps)` 与 `推了进度(shot)` 并存，
证明节流仍生效、只是被新截图越过：

```
[progress] 跳过（too_few_steps，第 3 步）
[progress] 推了进度（shot，5 步）        ← 越过节流，带图
[progress] 推了进度（shot，7 步）        ← 新图，再带
[progress] 跳过（too_few_steps，第 9 步）
[progress] 推了进度（shot，11 步）
```

**这次是真的跑通了**：4 张不同的 PNG，`progress_image ok=1` × 4，零重复。

---

## 10. 事实边界

**实测**（2026-10-21 更新）：41 工具、9 delta/2 final、`sendImage` 存在、
28 HTTP 端点（新增 `/api/activity`）、6 Web 视图、无原生工程、
心跳事件经确定性短路建任务并实收飞书推送。

**判断（可能错）**：
- 「接截图是小工量」—— 看了依赖链，没写
- 「IMAP + .ics 覆盖 80%」—— 取决于你要「能用」还是「像原生客户端」
- 「原生 App 不该做」—— 产品判断，不是技术限制
- 「付款定为不支持是对的选择」—— 产品/风险判断（真钱 + 无支付通道），见 §7.6；
  技术上能不能接是另一回事，本轮**没做**也**不打算做**

**2026-10-22 补充实测**：`grep -rni stripe src/` → 0；`grep -rni shop src/` → 0；
`config/tools.yml` 里 active 的 `tier: spend` 条目 **0 个**，active `dangerous` 只有
`fs.remove` / `mcp.call` / `tool.create` / `tool.invoke` / `mail.send` 五个。
（`shop.checkout` 只存在于 :122-126 的**注释模板**与两个测试夹具里。）

**未验**：真人收到卡片/进度的观感、跨网络稳定性、Muse 的记忆/并行/重试机制（见 `meta-muse.md` §8）。
