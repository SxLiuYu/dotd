# dotd 与 Muse / Dots 的差距（2026-10-22，基于实测）

> 判断依据全部来自本仓库代码与运行库，不引用宣传语。
> 每一条都给了可复核的命令或 `file:line`。

## 0. 一句话结论

**能力面已经对齐 —— 但这句话在 2026-10-22 复核时差点是错的，值得先说清楚。**

上一版写"功能面已经没有实质差距"。复核发现当时有 **4 个工具的实现写完了、
却调用不到**（详见 §1.1）：模型要么看不见名字，要么每次拿到 `deny`。
它们在上一版的盘点里被算成"已有"，因为代码里确实有。

修完这 4 个之后的真实状态：

- ✅ **能力面对齐**：Muse 公开清单里的网页操作、邮件、日历、定时、记忆、检索、
  连接器，dotd 都有，且多数更严（治理五档 + 审批）。共 46 个能力。
- ⬜ **付款未做**：Muse 能存卡后一句 "Go for it" 下单，dotd 只能做到填单、
  最后一步由人按。结构已备好（`spend` 档），是刻意留的，见 §2.4。
- ⬜ **GitHub 私有仓**：只差 `DOTD_GITHUB_TOKEN`，代码不用改。
- ⬜ **MCP 连接器**：未配置。**不建议**放宽——每次审批是刻意的，见 §2.2。

剩下的所谓差距，主要是**产品化程度**（开箱即用的托管账号、OAuth 一键连接），
不是**能力**。而所谓"日历 0 个源"在上一版被列为待补——复核后是**误判**：
本地日历靠对话长出来，本来就通，只是没往里加东西所以是空的（§2.1）。

## 0.1 真机逐项验收（2026-10-22 第三轮，Muse §2.1 那张表逐条跑）

前两轮做的都是**静态对账**（能力表 vs 白名单 vs 宿主集合）。静态对账能证明
「名字都在」，证明不了「真的能用」——而 §1.1 那 4 个缺陷正是死在这一点上。
这一轮改成拿 Muse 原文的能力清单**逐条发真任务**，看真实工具返回。

| Muse 实测能力（docs/meta-muse.md §2.1）| dotd | 真机证据 |
|---|---|---|
| 读 Gmail（查线程、判时间线）| ✅ | `[mail.list] succeeded :: {"count":3,...}`，真实邮件「您已完成实名认证」(OPPO)；`[mail.read]` 拿到完整正文与 Date 头 |
| 起草邮件（能改语气）| ✅ | `[mail.draft] succeeded :: {"draftId":"md_844014984a7843ec","note":"草稿已生成，**尚未发送**"}` |
| 操作电商网站（搜索、比价、加购物车）| ✅ | `[browser.open] succeeded :: title:"Ecommerce Test Site to Learn Web Scraping"` + `[browser.snapshot]` 拿到 4383 字符的完整 DOM 结构，含 `link "Abominable Hoodie ... $69.00"`、`button "Search"`、`combobox "Shop order"` |
| 填表单（地址/电话/姓名，可视化浏览器里填）| ✅ | 上一轮已验证：`https://httpbin.org/forms/post` 填三个字段 + 选 bacon + 提交，**服务端回显** `{"custname":"张三","custtel":"13800001111","custemail":"zhangsan@example.com","topping":"bacon"}` |
| 主动要信息（缺地址就问）| ✅ | `ask_user` 通道在（治理审批面 `/api/approvals`），本轮的悬置问题就是用它问的 |
| 管账号（登录、查套餐）| ✅ | `browser.*` 的 `--session` 按域名派生持久登录态，跨进程保留 cookie（`webtools.ts:348`）|
| 付款（连一次卡，之后一说就买）| ⬜ | 结构齐备、后端未接，见 §2.4。**这是唯一真实缺口** |

### 这一轮为此修掉的两个真缺陷

验收过程中撞到两个缺陷，都不是「代码写错」而是「判据设计错」，已修：

1. **水位阈值永远不可达 → 全任务卡死**（`ec1032f`）。
   标定把 `baseMb` 取成 MemAvailable 的 p50，又拿 `base + 6144` 当 normal 线：
   24GB 机器空载时算出 28.5GB，**超过物理总量**，于是永远回不到 normal，
   guard 持续 pause 容器。现场表现就是「发什么都 queued 不动」。
   谁也没想到根因在内存水位上——它伪装成「模型不出话」。
2. **慢站一律打不开**（`795b072`）。
   `browser.open` 把「浏览器冷启动」和「首次导航」压在一次调用里，
   挤爆 agent-browser 内部的固定预算，稳定 27~28s 超时；
   而报错是 `os error 11` / `ERR_NAME_NOT_RESOLVED`，看起来像网络故障。
   curl 同一 URL 只要 6.5s，证明不是网络。

两个缺陷的共同点：**失败信息指向的位置都不是真因**。
这也说明为什么必须真机验收 —— 静态对账对这两个缺陷完全无感。

---
## 1. 工具面：46 个，覆盖 Muse 公开清单

实测 **46 个能力**（`CAPABILITY_CATALOG`，见 `src/exec/protocol.ts:98`）：

```
文件 6 · 记忆 1 · 命令 1 · 浏览器 5 · 网络 2 · 搜索 2 · 定时 3 · 造工具 3
邮件 8 · 日历 7 · 连接器 5 · 保险库 1 · web 3
```

> 2026-10-22 复核：原文档写「40 个」，当时实际已是 44（`fs.grep` / `memory.search`
> 那天加进去了，数字没跟上）。本轮又补了 `calendar.list` / `calendar.conflicts`，
> 现在是 46。**权威来源请直接跑**：
>
> ```bash
> node --import tsx -e "import('./src/exec/protocol.ts').then(m=>console.log(m.CAPABILITY_CATALOG.length))"
> ```

对照 Muse 的公开功能（网页操作、邮件、日历、定时、记忆、连接器），**没有一项是缺的**。
`search.web` / `search.fetch` 是 2026-10-22 新增，补上了唯一真正缺失的基础能力——联网检索。

## 1.1 工具"做完但没接上线"这一类缺陷（2026-10-22 新发现，已修）

复核工具面时发现 **4 个工具的实现写完了、却调用不到**。它们不是"没做"，是"做完没接线"，
因此任何只看代码的盘点都会把它们算成"已有"，实际用起来全是失败：

| 工具 | 实现位置 | 断在哪 | 后果 |
|---|---|---|---|
| `calendar.list` | `daemon.ts:1279` 已注册 | 不在 `CAPABILITY_CATALOG`，也不在 `HOST_SIDE_TOOLS` | 模型**根本看不见**这个名字 |
| `calendar.conflicts` | `daemon.ts:1290` 已注册 | 同上 | 同上 |
| `fs.grep` | `agent-runtime/fs.ts:394` 容器侧完整 | `config/tools.yml` **没登记** | `gate.ts:327` 判「工具未登记」→ **每次调用都 deny** |
| `memory.search` | `daemon.ts:1692` 已注册 | `config/tools.yml` **没登记** | 同上 |

两条不同的断法，都值得记住：

1. **能力目录断**（`calendar.*`）。`ExecService.getCapabilities` 只合并「既在我的
   `CAPABILITY_CATALOG` 里、又在 `HOST_SIDE_TOOLS` 集合里」的工具（`:1144`）。
   两个条件缺一个，模型就永远看不见。注释里 2026-10-18 记过同一个事故：
   `schedule.create` 当时也是这样，主人让设提醒，模型答"工具不在列表里"。
2. **白名单断**（`fs.grep` / `memory.search`）。实现能用，但治理是白名单制，
   `gate.ts:325` 写死「未登记 ⇒ deny」。这类断法更隐蔽：
   `tools.yml` 里没有它，模型看得见名字（因为能力表里有）、每次都拿到 `deny`，
   而 `deny` 在日志里看起来像"模型自己决定不做"。

**为什么测试没抓到**：两处都是"少一条登记"而不是"逻辑写错"，
而当时的测试只断言"能力表内部自洽"与"白名单内部自洽"，
**没人断言两者的交集**。本轮补的验证方式是直接对账：

```bash
node --import tsx -e "
  Promise.all([import('./src/exec/protocol.ts'), import('./src/governance/catalog.ts')])
    .then(([p, c]) => {
      const caps = p.CAPABILITY_CATALOG.map(x => x.name);
      const reg  = [...c.loadCatalogFile('config/tools.yml').catalog.tools.keys()];
      console.log('能力表有但未登记:', caps.filter(n => !reg.includes(n)));
    })"
```

修后状态：能力表 46、白名单 47，差项只剩 `mcp.call`（设计上由 `visibleCaps` 单独管，是对的）。

**端到端复验**（真实 daemon + 真实模型，不是单测）：

```
[assistant] {"calls":[{"name":"calendar.list","arguments":"{\"window_days\": 7}"}]}
[system]    {"tool":"calendar.list","ok":true,"value":{"events":[],"text":"未来 7 天没有日程。"}}
[assistant] 调用了 calendar.list（window_days=7），结果 0 条日程。

[system] {"tool":"calendar.conflicts","ok":true,"value":{"checkedCount":0,...}}
[system] {"tool":"fs.grep","ok":true,"value":{"scanned_files":273,"matches":[...]}}
[system] {"tool":"memory.search","ok":true,"value":{"count":8,...}}
```

四个工具从"看不见/必 deny"变成真实返回结果。

## 2. 三处真实差距

### 2.1 日历：不再靠订阅，靠对话长出来（影响：已解决）

```
calendar | ready | 0 个日历源 / 0 个事件
```

**这里原先我判断错了。** 先前写的是「缺 `.ics` 订阅源，能补」，方向是反的：
要求主人先有日历、再喂给 dotd，等于让工具去适配一份本来不存在的文件。
主人的实际用法是**在聊天里说出安排**，dotd 当场落成事件 —— 现在这条路是通的：

| 能力 | 工具 | 档位 | 要审批吗 |
|---|---|---|---|
| 说一句就记下 | `calendar.add` | write_file | 否 |
| 改时间/地点 | `calendar.edit` | write_file | 否 |
| 删掉 | `calendar.delete` | write_file | 否 |
| 约时间前查撞不撞 | `calendar.conflicts` | read | 否 |
| 看已有安排 | `calendar.list` | read | 否 |

订阅 `.ics` 仍然保留（只读、能力在），但**它不再是前置条件**：
主人一份日历都没有时，照样能直接说"下周三下午三点和产品评审"。

### 2.1.1 节假日 / 调休 / 休息去哪（新增，2026-10-22）

主人日常问得最多的其实不是"我有什么安排"，而是这三件事：

| 问题 | 工具 | 数据来源 |
|---|---|---|
| 明天上不上班？这周六要补班吗？ | `calendar.day` | 公开节假日表（含调休） |
| 国庆放几天？今年哪几个假？ | `calendar.rest` → `holidayRuns` | 同上 |
| 哪几天补班？ | `calendar.rest` → `makeupDays` | 同上 |
| 下个周末适合出去玩吗？ | `calendar.rest` → `weather` | open-meteo（零 key） |
| 那去哪儿？ | 模型结合记忆 + `search.web` | — |

两个设计取舍值得记下来：

1. **多源降级 + 本地缓存**（`src/connectors/holiday.ts`）。
   实测 `api.apihubs.cn` 一开始能返回全年 365 天，几分钟后对任何参数都返回
   `code=80006`（限额）。免费源就是这样，所以代码里按顺序试
   apihubs → dreace.top，命中就落 `<dataDir>/cache/holiday-YYYY.json`。
   两个都挂时明确返回 `HOLIDAY_SOURCE_DOWN`（retryable），**不编造"没查到假期"**。

2. **只给事实，不给景点**（`src/connectors/rest-plan.ts`）。
   工具产出的是「哪几天连休 + 那几天天气数值」，具体推荐去哪由模型结合
   记忆里的偏好去说。硬编码景点库既不准、又很快过期，还会让回复千篇一律。
   主人没说城市时按北京取天气，返回里带 `assumedBeijing=true`，模型必须讲明这是假设。

这两个工具都是 `read` 档，**不弹审批**。

### 2.2 MCP 未配置（影响：中低）

```
mcp | not_configured | 没有配置任何 MCP server
```

通道本身是通的（`config/mcp-servers.yml` 空表 `servers: []`），
`mcp.call` 也能走，但**每次调用都要审批**（dangerous 档）——这是刻意的安全设计，
不是缺陷。对日常高频调用等于不可用。

**能补**：给可信 server 开白名单档位。**但**这会削弱审批模型，我不建议为了对齐功能而做。

### 2.3 GitHub 只能读公开仓（影响：低）

```
connector github | public_only | 未认证公开 API，限速 60 请求/小时
```

缺 `DOTD_GITHUB_TOKEN`。补上即可读私有仓 + 提限额到 5000/小时。

### 2.4 付款：唯一还在的能力缺口（影响：中）

Muse 的实测里最有分量的一条是**付款**：连一次 Stripe，之后只要说 "Go for it" 就下单。
dotd 目前**没有**同类能力 —— 这不是配置问题，是真的没做：

```
$ 查能力表里含 pay/spend/buy/checkout 的工具 →（无）
$ 查 config/tools.yml 的 spend 档条目       →（只有一份注释形式的占位）
```

`config/tools.yml:120-128` 留了结构定型但**没有实际条目**：
原注释写「阶段一工具词表无 spend 档工具；购物走 browser.act 由 review 承接」。

**这不是遗漏，是刻意留的**，理由站得住：

- `browser.act` 已经能完成"选品→加购物车"，只是付款那一步要人接手。
  这和 Muse 报道里的真实行为**一致**——记者也是自己付的款。
- 真要自动化付款，需要存卡凭证。dotd 的保险库（`vault.*`）能存，
  但"让 agent 自主花钱"的风险与收益完全取决于信任程度，不该由我替主人决定。

**补齐的成本是小的**（按 `tools.yml:122` 的占位形状加一条 `tier: spend` + `spendParams`，
`gate.ts:330` 的 spend 契约校验已经写好了）。要不要补，取决于主人是否想要"一说就买"。
目前的等价路径：`browser.act` 填单 → 人在浏览器里按最后一下。

## 3. 已经追平甚至超过的部分

### 3.0 分级审批：Dots 有，dotd 也有（此文档此前漏记）

报道里明确写过一句：**「只知道付款要按，不知道能不能设『超过 $X 就要问』」**
（`docs/meta-muse.md:211`）—— 并注明**这是 OpenAI Dots 明确有的功能，Muse 报道里没提**。

所以「按金额分级审批」是 Dots 相对 Muse 的差异点，也必须是本目标的验收项之一。

**实测结论：dotd 已具备，且比 Dots 的描述更通用。**

| 能力 | Dots | dotd | 证据 |
|---|---|---|---|
| 按金额决定要不要问人 | ✅ | ✅ | `src/governance/gate.ts:781-789`（`amountAtLeast` 谓词）|
| 单位 | 美元 | 分（ISO 4217 三字母币种）| `gate.ts:1655` `SpendParams` |
| 与其他条件组合 | 未提及 | ✅ tool / urlHost / pathPrefix / 金额 可叠加 | `gate.ts:772`（urlHost）/ `:777`（pathPrefix）/ `:781`（金额）|
| 只可收紧不可放宽 | 未提及 | ✅ 降档在加载时被拒绝并告警 | `config/rules.yml:1-9` |
| 花钱留痕 | 未提及 | ✅ `spend_ledger` + 人工补录 | `gate.ts:1679` `recordSpendAdjustment` |

配置形状（`config/rules.yml`，当前是空列表 —— 默认不预设任何收紧规则）：

```yaml
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 50000        # 500.00 元（单位：分）
    decision: approve
    reason: "单笔 >= 500 元必须人工确认"
```

**为什么生产配置是空的**：空是**有意的默认值**，不是没做完 ——
不预设收紧规则意味着「没登记的工具一律 deny」，这是更保守的起点。
要用的人按上面的形状自己加一行即可，不用改代码。
已有 9 条断言覆盖这个谓词（`tests/amount-threshold-rule.test.ts`），含坏值校验
（`amountAtLeast: 0` 会被拒，不会被当成"配好了"）。


| 能力 | dotd 现状 | 说明 |
|---|---|---|
| 常驻运行 | ✅ | daemon + 每 Dot 一个 Docker 容器 |
| 跨会话记忆 | ✅ | `mem_messages` + FTS + MEMORY.md |
| 真实网页操作 | ✅ | `web.*` 五件套（Playwright） |
| 联网检索 | ✅ **已超** | argo 272 源，能拿到 jd/tmall 这些直连打不开的站 |
| 审批治理 | ✅ **已超** | 分层 tier + 单写者 + 可审计 |
| 端到端可测 | ✅ **已超** | 1689 个测试，`tsc` 零错误 |
| 邮件收发 | ✅ **刚接通** | 真实 IMAP/SMTP，8 工具全注册 |
| 自造工具 | ✅ | `tool.create` → `tool.invoke` |

Muse 有而 dotd 没有的，据其公开材料只剩"开箱即用的日历/邮件托管账号"——
那是**产品化程度**的差距，不是**能力**的差距。

## 4. 搜索：为什么用 argo 而不是内置

内置搜索的判断（`src/runner/tool-catalog.ts` 的 `NET_SEARCH_GUIDE` 注释）写于 2026-10-18，
当时的结论是"bing 返回与查询无关的结果，不值得内置"。**这个结论今天仍然成立**，
但前提变了：

- 直连：`jd` / `tmall` / `smzdm` / `amazon` 全部 `000`（不通）。
- 走 7890 代理：`jd` / `smzdm` 仍 `000`。
- argo：不经过本机出口，**能拿到**京东 348 元、中关村在线 328.5 元这类真实报价。

所以不是"要不要搜索引擎"的问题，是"本机根本没有通路"的问题。argo 是绕开通路限制，
不是替换搜索质量。详见 `docs/argo-search-wiring.md`。

## 5. 要缩短差距，按性价比排序

| # | 做什么 | 成本 | 状态 |
|---|---|---|---|
| 1 | **节假日/调休/休息推荐**（`calendar.day` + `calendar.rest`） | 小 | ✅ **已完成**（2026-10-22） |
| 2 | 日历改为「对话长出来」而非订阅（撤销原判断） | 0 | ✅ 本来就通，文档已更正 |
| 3 | 修 DSML 偶发 | 小 | ✅ 已完成 |
| 4 | **接上 4 个「做完没接线」的工具**（见 §1.1） | 小 | ✅ **已完成**（2026-10-22） |
| 5 | 配 `DOTD_GITHUB_TOKEN` | 极小 | 待做（可选：私有仓 + 限额 ×83） |
| 6 | **付款**（`tier: spend` + 存卡） | 小-中 | 未做。结构已备好，见 §2.4；要不要做取决于信任程度 |
| 7 | MCP 白名单 | 中 | **不建议**（削弱审批模型） |
| 8 | 日历双向同步（CalDAV） | 大 | 只在真需要写第三方日历时才做 |

## 6. 结论（2026-10-22 复核后）

**能对齐的都对齐了，剩下三项各有明确理由不做或等判断：**

| 项 | 状态 | 理由 |
|---|---|---|
| Muse 的公开能力清单（网页/邮件/日历/定时/记忆/连接器/检索） | ✅ 全覆盖 | 逐条对过，见 §1、§3 |
| 付款（Stripe 式） | ⬜ 未做 | 结构已备（`spend` 档 + spendParams 契约），缺"存卡+自主下单"。等主人判断，见 §2.4 |
| GitHub 私有仓 | ✅ **已可用**（本轮实测更正） | 不需要任何改动：token 由保险库在启动时注入（`src/daemon.ts:1566-1578`，`site='github.com', user='token'`），连接器状态实测为 `connected`（认证 API，5000 请求/小时）。上一版写「待配置」是因为只看了 `DOTD_GITHUB_TOKEN` 环境变量为空就下结论——**那次判断是错的** |
| MCP 常用化 | ⬜ 不建议 | 每次审批是刻意设计，放宽会削弱整个审批模型 |

**GitHub 这条的第一手证据**（2026-10-22 真机，不是推断）：
```
[github.notifications] succeeded :: {"ok":true,"status":200,"rateLeft":4999,"data":[]}
```
`rateLeft: 4999` 是关键——未认证只能是 60 次/小时，4999 只可能来自 5000 额度，
所以这确实是**认证**调用。保险库条目实测存在：`{"site":"github.com","user":"token"}`。

**上一版文档写「功能面已经没有实质差距」，这次复核发现那句话成立但理由不对** ——
不是"都做完了"，而是"做完了 4 个却没接上线、所以在我上一版的盘点里被误算成已具备"。
修完之后才是真的没有实质差距。这个区别值得记下来：
**盘点的对象必须是"模型实际调得动的工具"，不是"代码里存在的实现"。**

