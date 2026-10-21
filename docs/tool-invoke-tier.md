# `tool.invoke` 为什么要审批，以及该不该放宽

> 状态：**结论是「维持 dangerous」，但这属于你的产品判断，我没动。**
> 本文把取舍摆清楚，供你决定。写于 2026-10-21。

## 一、现状

`config/tools.yml:112-115`：

```yaml
  - name: tool.create
    tier: dangerous
  - name: tool.invoke
    tier: dangerous
```

配置文件里已经写了理由（`tools.yml:103-109`）：

> - `tool.create` dangerous：**写一个可执行文件**，下次还会自动跑它。
>   这等价于"让 AI 往系统里种代码"，必须主人点头（GOV 五档里 dangerous=人工审批）。
> - `tool.invoke` dangerous：执行一个**之前生成的、现在没人看过的**脚本。
>   主人批准的是"造"的那一刻，不是"每次跑"——所以跑也要批。
>   如果以后发现太繁琐，可降为 write_file + 首次执行审批，但**默认从严**。

## 二、为什么现在开始碍事

实测（`approvals` 表，`status='executing'` 的 126 条）：

```
tool.invoke   93 条  ← 占 74%
tool.create   17 条
browser.*     13 条
shell.run      2 条
fs.remove      1 条
```

模型想统计一段文字的字数，被迫走 `tool.create` 造个 `word-count`、再
`tool.invoke` 调它 —— **两次人工审批**，就为了数几个词。

真实案例：任务 `tk_mvhygznnjpvy9g`（写 800 字茶史）卡在 `#134`，
审批的正是 `tool.invoke word-count`。主人点了「同意」之前，任务一直是
`awaiting_approval`。

更糟的是模型会**反复重试**：`#133` 被裁决后它又发了 `#134`，
说明"造工具"这条路径对它来说成本感很低，而审批对人是打断。

## 三、`sideEffect: 'unknown'` 是核心事实

`src/exec/protocol.ts:336`：

```ts
name: 'tool.invoke',
mode: 'sync',
max_deadline_ms: 60_000,
sideEffect: 'unknown',
```

`unknown` 意味着治理层**无法判断**这次调用会不会删文件、发邮件、花钱。
而 `tool.create` 造出来的脚本是**任意代码**：`run.sh` / `.py` / `.mjs`，
按扩展名选解释器，从 `argv[1]` 读 JSON，结果打 stdout。

也就是说：**一次 `tool.invoke` 的能力上限 = 该用户 shell 的能力上限。**
它可以 `rm -rf`、可以读 `~/.ssh`、可以 `curl` 出去。

## 四、三条路

### A. 维持 `dangerous`（现状，我建议）

**好处**：语义正确 —— 执行的确实是任意代码，且主人看不见内容。
与 `shell.run`（同样是任意代码）保持同档，一致性上没有裂缝。

**代价**：常见小工具（数词、转格式、查时区）也要点一次审批。

### B. 降为 `review`（模型预检）

`src/governance/gate.ts:592-610`：`pre.verdict === 'safe'` 时 **不经过人就放行**。

**好处**：小工具不再打断人。

**代价，必须说清**：这等于**让模型自己决定要不要执行任意代码**。
预检模型看到的是工具名和参数，看不到脚本内容（内容在磁盘上）。
一个叫 `format-date` 的工具里写 `rm -rf ~` 是完全可以的，
预检会判「safe」。**所以这条路我判定为不该做**，不是做不到。

### C. `tool.create` 时审脚本，`tool.invoke` 免审

这是 `tools.yml` 注释里作者自己提到的方向（"可降为 write_file + 首次执行审批"）。

**好处**：审批次数从 2 降到 1，且人看的是**真正该看的东西**（脚本内容）。

**代价/难点**：需要「这个工具我批过」的持久记录，否则每次仍要审。
现有结构里没有这个概念 —— `approvals` 是一次性的，没有"对某工具长期授权"。
要做得干净，需要一个新的授权表（`tool_grants`），并且要处理脚本变更
（覆盖同名工具时旧授权必须失效，`tool.create` 已有 `.archive/` 机制可用）。
**这是能做的，但是一个小项目**，不是改一行配置。

## 五、我的建议

**先做 C 的最小版本**，而不是 B：

1. `tool.create` 保持 `dangerous`（人看脚本，这一步价值最大）
2. 审批通过时，把工具名 + 脚本 sha256 记进一张新表
3. `tool.invoke` 的 `matchRules` 里加一条：**同名 + sha256 一致 → 降为 `allow`**
4. 脚本一改（sha256 变），授权自动失效，下次仍要审

这样：人只在"种代码"那一刻被打断一次，之后复用不打断；
而**执行的永远是主人看过的那份脚本**，不是模型临场编的。

第 3 步涉及"让规则放宽"，而 `GOV §2.6` 规定 `rules.yml` 只能收紧不能放宽，
`decision: allow` 会以 `rule_not_stricter` 拒绝加载。所以不能在 `rules.yml` 里做，
得在治理层加一个**内置的、有凭据支撑的**降档判断（凭据 = 那张授权表），
而不是让配置说话。这一点需要你确认是否算破坏 §2.6 的本意。

## 六、按你的要求分两类

**做不到（技术上限）**：
- 让预检模型判断"任意脚本安不安全" —— 它看不到脚本内容，判断无依据

**不该做（能做到，是产品决定）**：
- B：`tool.invoke` 降 `review`（等于模型自主执行任意代码）
- C：需要新增 `tool_grants` 表 + 治理层内置降档，且要你认可不违反 §2.6
