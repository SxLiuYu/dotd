# Meta Muse 产品形态（网络调研）

> 调研于 2026-10-20。**全部内容来自 The Verge 的 16 篇报道**（可访问的唯一可靠信源）。
> 每一条都标了出处。**凡是报道里没有的，我不写。**
>
> ⚠️ 这不是官方文档。The Verge 是科技媒体，有立场、有取舍。
> 我尽量只取**事实性描述**（它做了什么、怎么做的），少取评价。

---

## 一句话

**Muse 是 Meta 的「人人可用的 AI 智能体」** ——
不是聊天机器人，是一个**住在云端隔离 Linux 电脑里、有浏览器、能用你的账号帮你把事办完**的助手。
它的形象是**一只可爱的小熊**，你可以给它起名。

> Zuckerberg 描述它是 **"an isolated linux computer with a browser, CPU, memory, and storage"**
> —— 出处：privacy 那篇（The Verge, Hayden Field）

---

## 1. 产品形态：它长什么样

### 1.1 多端 App（不是网页聊天框）

| 平台 | 状态 | 出处 |
|---|---|---|
| **iOS** | 首发，登顶 App Store 免费榜数周 | iPad 那篇 |
| **Android** | 首发 | Mac App 那篇 |
| **Web** | 首发 | Mac App 那篇 |
| **macOS** | 首发约一周后推出 | Mac App 那篇 |
| **iPad** | 原生支持大屏与多任务 | iPad 那篇 |
| **Windows** | 已宣布，**无时间表** | Windows 那篇 |

**关键点**：它是**真的原生 App**，不是套壳网页。
Mac 版能做「整理文件、填表单、从 Messages / Calendar / Notes 里取信息」。

### 1.2 硬件：Muse Charm

> 一个 **Tamagotchi 风格的独立设备**，不接手机也能跑 Muse。
> —— iPad 那篇

还有 **Muse 眼镜**（Meta Connect 2026 发布）。

**这说明 Muse 不是一个 App，是一个生态**：手机 + 电脑 + 可穿戴 + 桌面小设备。

### 1.3 形象：一只小熊

- 你可以给它**起名字**（记者起了 "Marley"）
- 它会**主动找你**：「它上周一直在 ping 我，想让我知道它能帮上什么忙」
- 记者原话：「**一个可爱的小家伙拿着你的信用卡在网上跑，花钱变得惊人地容易**」

> **这是产品设计的核心**：用可爱降低防备，让人愿意交出权限。

---

## 2. 能力：它实际能做什么（一手实测）

The Verge 记者 Allison Johnson 用它干了一整个上午的活。**这是最有价值的部分** ——
不是「它宣称能做什么」，是「它实际做成了什么」。

| 任务 | 难度 | 结果 | 它具体做了什么 |
|---|---|---|---|
| **跟进园林公司报价** | 极低 | ✅ **完成** | 要 Gmail 权限 → 查邮件 → 发现超期 → **起草一封邮件** → 记者说「太长了」→ 改短 |
| **买咖啡机蒸汽棒配件** | 低 | ⚠️ **基本完成** | 找到配件 → **加进购物车** → 记者自己付的款 |
| **降级安防系统套餐** | 中（要打电话）| ❌ **没完成** | 能登录账号、查到「必须打电话」→ **但它不能打电话**（据说在做了）|
| **联系垃圾清运公司** | 中 | ⚠️ **基本完成** | 搜本地服务 → **问记者要地址、电话、树枝照片** → 用这些去询价 |
| **买露营厨具 + 火盆** | 中 | ✅ **完成** | 跨多个站点比价选品 → 凑齐一套 → **总价 $500** → 记者喊停，改成分批买 |
| **买更多咖啡机配件** | 低 | ✅ **完成** | 连了 Stripe → 之后**只要说「Go for it」就下单** |

### 2.1 从这些实测里能读出的能力清单

**必备的**
- ✅ **读 Gmail**（要授权）：查线程、判断时间线
- ✅ **起草邮件**（能改、能变语气）
- ✅ **操作电商网站**：搜索、比价、加购物车
- ✅ **填表单**：地址、电话、姓名，**在虚拟浏览器窗口里填，记者能看见**
- ✅ **主动要信息**：缺地址就问你，缺照片就问你
- ✅ **管账号**：登录安防系统、查套餐
- ✅ **付款**（Stripe 集成）：**连一次卡，之后一说就买**

**做不到的（截至报道时）**
- ❌ **打电话**（"apparently that ability is in the works"）
- ❌ **访问 Amazon**（被明确拦截，还弹了「AI agent 违反服务条款」的警告）
- ⚠️ 复杂下单要人接手（"I had to finish up the order myself"）

### 2.2 架构：它怎么做到的

> **云端隔离 Linux 电脑**：有浏览器、CPU、内存、存储。每个用户一台 VM。
> —— Zuckerberg，转引自 privacy 那篇

**和 dotd 的架构几乎一样**：容器/VM + 浏览器 + 文件，agent 在里面操作。

差别在**规模**：Meta 是「每人一台 VM，服务数十亿人」，dotd 是「你机器上一个 Docker 容器」。

**曾经出过 VM 逃逸漏洞**（404 Media 报道，The Verge 跟进）：
> 漏洞可能让 Muse **逃出虚拟机**，访问 Meta 的数据库和服务。
> 内部人士说安全团队被要求「尽快热修，但不能推迟发布」，
> 导致「**半生不熟的防护被赶着上线**」。

---

## 3. 集成：它能连什么

### 3.1 已支持

| 类别 | 具体 |
|---|---|
| **Google** | Gmail、Calendar（OAuth 授权）|
| **支付** | **Stripe**（连一次卡，之后免密下单）|
| **办公/设计** | Canva、Figma、Dropbox、Zoom、Asana、QuickBooks、GitHub、Klaviyo |
| **笔记** | Notion、Granola |
| **本机（Mac）** | Messages、Calendar、Notes |
| **Meta 自家** | Marketplace（能替你发布/回复）|

### 3.2 连接器是「一次更新加一批」的节奏

iPad 那次更新一口气加了 8 个（Canva / Dropbox / Figma / QuickBooks / GitHub / Zoom / Asana / Klaviyo）
+ 2 个连接器（Granola / Notion），**明确瞄准小企业主**。

---

## 4. 隐私与安全：这是它最大的争议

The Verge 的报道里，**这一块篇幅最大**，必须如实写：

| 事实 | 出处 |
|---|---|
| 数据存在**隔离 VM** 里，与其他用户隔离 | privacy 篇 |
| **但 Meta 自己仍能访问** 你 VM 里的数据 | privacy 篇 |
| 官方称「今年晚些时候」会提供**密码学可验证**的方式阻止 Meta 访问 | privacy 篇 |
| **默认允许 Meta 用你的数据训练模型**（可关闭）| privacy 篇 |
| Inc. 记者抱怨：**没让它读，它自己上传并读了我的私信** | privacy 篇 |
| 有 YouTuber 说：它**把我的地址通过 Marketplace 给了陌生人** | privacy 篇 |
| 官方回应：这两例都是「**按设计工作**」 | privacy 篇 |

> The Verge 记者原话：
> 「用了 40 分钟，我已经给了它我的全名、地址、信用卡号、
> **一张我后院的照片**、还有安防账号的登录凭据。」

**这是产品形态的一部分** —— 不是缺陷列表，是它换取能力的代价。

---

## 5. 竞争格局（报道里的定位）

| 产品 | 归属 | 定位 |
|---|---|---|
| **Muse** | Meta | 「人人可用的 agent」，靠可爱 + App Store 分发 |
| **Dots** | OpenAI | 隐私优先，$100/月起的 ChatGPT 档才有 |
| **Grok Bot** | xAI | 和 X 深度绑定 |
| **OpenClaw** | 开源 | Muse 明确说「想做 OpenClaw 那样但安全」|
| **Instinct** | — | 因服务条款过于宽泛被批评 |
| **Spark** | Meta | Meta 自家的另一个模型 |

**Meta 的产品负责人原话**：
> "our goal with muse was to build **something like openclaw** that we could
> **make safe and secure and easy to use** and **scale to billions of people**."

**市场规模**：上线数周，美国 **60 万日活**（Apptopia 数据）。

---

## 6. 模型：Muse 背后是什么

- 首发用 **Muse Spark**
- 后续推出 **Muse Wonder** / **Muse Wonder Full**（对标 GPT-6 Astra、Claude Opus 5.5）
- 计划**最终让 Wonder 驱动 Muse agent**，先从订阅用户开始
- 另有 **Muse Image**（图像模型）

> 注意：**模型和 agent 是分开迭代的**。
> Muse 这个 App 一开始用的不是最好的模型。

---

## 7. 从 16 篇报道里提炼的产品原则

这些不是官方说的，是**从它怎么做里反推出来的**：

1. **降低门槛优先于能力最大化**
   可爱的小熊、起名字、主动 ping 你 —— 一切为了让普通人敢用。

2. **权限换能力，明码标价**
   要 Gmail、要信用卡、要后院的照片。给得越多，办成的越多。
   **不假装这是免费的。**

3. **人保留最后一击**
   加购物车可以，付款要你按；填表单可以，复杂下单要你接手。
   （但连了 Stripe 之后，按一次的成本被压得很低）

4. **看得见**
   「我盯着它开了一个又一个虚拟浏览器窗口」——
   操作过程是**可视的**，不是黑箱。

5. **多端同源**
   手机、电脑、iPad、眼镜、Charm —— 同一个 agent，跟着你走。

6. **先用最好的分发（App Store），再用最好的模型**
   先靠可爱和免费登顶，再慢慢升级脑子。

---

## 8. 我不确定的

1. **它到底怎么「记住」你** —— 报道没讲记忆机制
2. **多任务并行** —— 记者说「我给了它一个任务，然后又给一个」，
   但没说它是不是真并行，还是排队
3. **失败了怎么办** —— 只看到「没完成」，没看到它怎么解释、怎么重试
4. **它能不能主动做事** —— 只说「ping 我」，没说清是定时还是事件触发
5. **审批粒度** —— 只知道「付款要按」，不知道能不能设「超过 $X 就要问」
   （OpenAI 的 Dots 明确有这个功能，Muse 报道里没提）

---

## 9. 信源清单（16 篇，The Verge）

```
/ai-artificial-intelligence/999526/meta-muse-ai-agent-hands-on-shopping   ← 一手实测，最有用
/ai-artificial-intelligence/1009051/privacy-ai-agent-promises-openai-meta-muse-dots  ← 架构+隐私
/ai-artificial-intelligence/1009479/meta-muse-wonder-full-ai-model  ← 模型
/ai-artificial-intelligence/1008605/zuck-accelerated-muse-launch-in-response-to-instinct
/tech/1006813/muse-ai-agent-ios-app-ipad-support  ← iPad + 8 个集成
/tech/997332/metas-muse-ai-agent-now-has-a-mac-app  ← Mac 能力
/tech/1007079/muse-is-coming-to-windows
/tech/1004781/meta-reportedly-made-a-mad-dash-to-fix-a-muse-ai-breakout-bug-weeks-before-launch  ← VM 逃逸
/tech/1011938/muse-ai-data-friends-consent
/tech/1011184/muse-got-dethroned-by-a-chicken-sandwich
/tech/1009650/muse-has-some-interesting-predilections
/tech/999673/meta-connect-2026-muse-glasses-features
/column/999999/optimizer-meta-muse-ai-cute
/news/1012293/meta-apple-muse-spark-open-ai-model-mlx
/podcast/1006181/muse-dot-instinct-ai-agents-vergecast
/podcast/1007408/meta-muse-openai-dots-ai-agent-race-privacy-free
```
