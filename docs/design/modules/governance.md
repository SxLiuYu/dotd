# 模块详设：治理与审批（Governance）— rev2

> 上游契约：`dotd-design/CONTEXT.md`（下称 CONTEXT）。本模块落实 CONTEXT `架构:19` 行
> 「治理: 工具权限分级 + 审批状态机(Web卡片/Telegram回复双通道) + 执行前后审查 + 审计日志」，
> 并服务于 CONTEXT `架构:29` 行「应急模式…浏览器登录态操作强制转审批」与
> `分期:52` 行「阶段二…审批规则持久化」。
>
> **rev2 修订说明**：响应评审 14 条缺口。关键变化：审批单表属主声明与状态机权威统一（§0/§3）；
> seq 生成机制补全（§3.2/§7）；tools.yml 语法与 zod 对齐（§2）；登录态识别统一为调用参数
> `withIdentity`（§2.4/S2）；控制面联动钩子 `setAwaitingApproval/onApprovalSettled/forceApproval`
> 入接口面（§8）；quarantine 持久化 + 解除接口（§5.4/§7）；decisionId 落库（decisions 表）；
> 非工具审批单（synthetic/question）承接侦察候选与应急授权（§3.6）；审查模型容量核算与
> 自适应降级（§5.1）；spend_ledger 写入契约（§2.5/§8）；主人补充指令 `note` 通道（§3.3）。

---

## 0. 属主声明（供接缝仲裁，先于一切）

1. **审批的权威存储是本模块的 `approvals` 表（§7），裁决状态机以 §3.2 八态为准**。
   CONTEXT `架构:19` 把"审批状态机"划给治理，因此 surfaces.md 若自带 approval 表，
   只能作为**展示缓存或通知投递状态表（deliver_state）**，不得是裁决的第二次写入。
   surfaces.md 的 4 态（pending/decided/expired/cancelled）到本模块 8 态的投影映射见 §3.2.1。
2. **裁决终局不可翻案**：`rejected/expired` 是本模块的硬规则（§3.3）。surfaces.md 的
   "expired 后主人回复可复活为 decided"与之直接冲突，本模块**不采纳复活**；
   若主人要"迟到仍有效"，正解是**调大 TTL 或重发提醒**（`reminded_at` 机制，§3.4），
   而不是复活已过期单。此条列为开放问题 O1 提请仲裁。
3. **Telegram/Web/CLI 三通道全部经本模块 `decide()` 落库**；surfaces.md 中"唯一允许改
   approval 的写路径"必须指到本函数，其 `ident` 即本表 `seq` 的显示形态（`AP-#<seq>`），
   其 `decision` 枚举到本模块 `verdict` 的映射见 §3.3.1。
4. **登录态操作的识别字段统一为调用参数 `params.withIdentity`**（与 execution.md S5 约定
   一致）；本 rev 废除工具目录静态 `loginSensitive` 标记（§2.4）。
5. **库文件路径不在本模块硬编码**：全部表进"控制面属主持有的唯一 SQLite 库"，
   经环境变量 `DOTD_DB_PATH` 注入（§7 头注）。四处文档出现 4 个库名
   （control.db / db/main.db / ~/dotd/dotd.db / ~/.dotd/dotd.db），须由控制面属主
   一次性裁定，列开放问题 O5。

---

## 1. 模块职责与边界

### 1.1 职责（本模块说了算的事）

1. **工具权限分级**：维护工具档位目录（`tools.yml`），把执行面每个工具调用归入
   `read / write_file / browser / spend / dangerous` 五档；档位决定默认放行还是审批。
2. **审批状态机**：`pending → approved/rejected/expired → executed/failed/revoked`
   的唯一权威实现；任何通道（Web 卡片、Telegram 回复、CLI）的裁决都必须经过本模块落库。
   同时为**非工具主语**签发审批单（synthetic：侦察候选接入、应急模型覆盖、
   副作用未知强制审批；question：Agent 向主人提问），见 §3.6——这是 CONTEXT `已定:11`
   "接入必须主人批准"闭环的落点。
3. **双通道裁决与冲突仲裁**：定义先到先得规则、Telegram 序号寻址、Web 卡片状态同步、
   主人补充指令（note）通道。
4. **持久化记忆**：已批端点（endpoint_grants）与已批规则（approval_rules）的产生、
   匹配、失效、撤销；CONTEXT 阶段二"审批规则持久化"的落点。
5. **执行前审查（precheck brief）**：放行/批准时附带风险简报与禁止项，注入主循环上下文。
6. **执行后审查（post-review）**：结果脱敏后送低智能模型审查，产出 `ok / suspicious /
   quarantine` 结论并写审计；quarantine 状态**持久化在 `quarantines` 表**（§5.4），
   崩溃重启不丢，并向控制面提供同步查询 `isQuarantined(dotId)`。
7. **审计日志**：只追加的 `audit_log` + `decisions` 表，保留上限与归档回收
   （贴合 CONTEXT `机器约束:37`）。
8. **花钱台账**：`spend_ledger` 的写入方（§2.5 参数契约 + §8 resolveExecution 钩子）。
9. **应急模式收紧**：接收 ModelRouter 的 `emergency` 标志，动态提升审批严格度。

### 1.2 边界（明确不做的事）

| 不做 | 归属 |
|---|---|
| 实际执行工具（容器内 shell/浏览器/文件操作） | 执行面 |
| journal 步骤级幂等、崩溃恢复 | 执行面/journal（CONTEXT `参考:44`） |
| Web 页面渲染、Telegram 消息 I/O、消息投递重试 | 交互面（本模块供数据与回调） |
| 任务状态置位（awaiting_approval 等）与 journal.skipStep 调用 | 控制面（本模块只通过注入钩子通知它，§8.2） |
| 模型熔断、降级阶梯 | 模型路由（本模块只消费 emergency 标志并调用其低智能通道） |
| 求救消息发送 | 模型路由求救通道 |

### 1.3 在系统中的位置

治理是**进程内库**（同属 CONTEXT `架构:18` 的 TypeScript 单进程 daemon），不是独立服务。
主循环（控制面）在每次工具调用前同步调用 `evaluate()`；审批挂起时主循环让位，
恢复与推进由**治理在裁决/超时提交事务后立即调用注入的控制面钩子**驱动（§8.2），
不存在"事件发了没人接"的异步空洞。SQLite 单写者模型恰好保证"先到先得"裁决串行化；
注意 `synchronous=NORMAL`（WAL 下的持久性档位）与 `BEGIN IMMEDIATE`（写串行化）互不矛盾。

---

## 2. 工具权限分级

### 2.1 档位定义

```ts
// src/governance/tiers.ts
export type ToolTier =
  | "read"        // 0 档：只读。文件读、GET、搜索、读取浏览器页面状态
  | "write_file"  // 1 档：写 /dot/home 内文件；容器内非破坏性写
  | "browser"     // 2 档：浏览器操作（点击/提交/登录态使用/发布内容）
  | "spend"       // 3 档：花钱、对外发送承诺性内容、订阅、购买
  | "dangerous";  // 4 档：不可逆/越出沙箱：rm 卷、删容器、转账、生产部署、改宿主机
```

默认策略（可被 `rules.yml` 收紧、可被持久化记忆放宽至"免审批直通"，见 §4）：

| 档位 | 默认 | 理由 |
|---|---|---|
| read | `allow` | 无副作用；应急模式下仍直通 |
| write_file | `allow` | 写被限制在 `/dot/home` 卷内（执行面保证），失败可回滚 |
| browser | `review`（低智能模型执行前审查后放行，异常转审批） | 有外部副作用但可逆性中等 |
| spend | `approve` | 一律人工审批；记忆规则对其**永不生效**（§4.5） |
| dangerous | `approve` + 二次确认 | 一律人工审批，Web 卡片需勾选确认框；TG 通道禁用 `all` |

`emergency` 标志为真时（CONTEXT `架构:29`）查 `emergencyPolicy`：

```ts
// src/governance/policy.ts —— 覆盖默认策略，只严不宽
export const EMERGENCY_POLICY: Partial<Record<ToolTier, Decision0>> = {
  write_file: "review",     // 降为审查档；审查器不可用时按 §5.1.2 降级矩阵处理
  browser:    "approve",    // 全档人工；其中"登录态操作"恒为 approve（应急解除也不变）
  dangerous:  "deny",       // 冻结：不受理审批，直接拒绝
};
```

"登录态操作"的判定是**动态的、按调用参数**：
`call.tool.startsWith("browser.") && call.params.withIdentity === true`。
该判定独立于 emergency，作为 `alwaysApprove` 谓词存在（§3.1 伪码），
与 execution.md S5 的约定逐字一致；工具目录不再放静态 `loginSensitive` 标记。

### 2.2 工具目录配置 `config/tools.yml`

```yaml
# 工具档位目录：执行面注册工具时必须在此登记；未登记的工具一律 deny（白名单制）
# 本文件由治理加载器用 zod 校验（§2.3），非法即 daemon 拒绝启动。
tools:
  - name: fs.read
    tier: read
  - name: fs.write
    tier: write_file
    pathPrefixes: ["/dot/home/"]           # 写范围约束，执行面同享此契约（S2）
  - name: net.get
    tier: read
  - name: net.post
    tier: write_file                        # 对外 POST 有副作用：比 GET 高一档
  - name: browser.navigate
    tier: read                              # 只导航不交互
  - name: browser.act                       # click/type/submit 合并为一个动作工具
    tier: browser
    identityParam: withIdentity             # params 中此字段为 true ⇒ 登录态操作（§2.4）
  - name: browser.purchase
    tier: spend
    spendParams:                            # 花钱台账的字段契约，§2.5
      required: [amountCents, currency, category]
  - name: shell.exec
    tier: write_file                        # 容器内 shell
    upgrade:                                # 命中即提档（解析规则见 §3.1）
      tier: dangerous
      whenContains: ["rm ", "sudo ", "docker ", "> /dev/"]
```

### 2.3 加载与校验（zod）

```ts
// src/governance/catalog.ts
const Tier = z.enum(["read","write_file","browser","spend","dangerous"]);
export const ToolDef = z.object({
  name: z.string().min(3),                       // 与执行面注册名逐字一致
  tier: Tier,
  identityParam: z.string().optional(),          // 登录态判定字段名（browser.* 必填其一）
  pathPrefixes: z.array(z.string()).optional(),
  spendParams: z.object({ required: z.array(z.string()).min(1) }).optional(),
  upgrade: z.object({                            // rev2：与 YAML 数据形状一致（评审缺口#8）
    tier: Tier,
    whenContains: z.array(z.string()).min(1),    // 子串匹配，见 §3.1 upgradeHit
  }).optional(),
});
export const CatalogFile = z.object({ tools: z.array(ToolDef).nonEmpty() });
export function loadCatalog(p: string): Catalog; // 启动校验：zod 失败 ⇒ throw ⇒ daemon 拒启动
```

校验细则：`tier == "spend"` 的条目**必须**带 `spendParams`（缺则加载失败）；
`name` 以 `browser.` 开头且 `tier >= browser` 的条目**必须**声明 `identityParam`
（缺则加载失败——杜绝"登录态无法判定"）。

### 2.4 登录态识别契约（跨模块，唯一落点）

- 识别字段：`ToolCall.params[def.identityParam]`（约定名 `withIdentity: boolean`）。
- 判定式：`isLoginSensitive(def, call) = !!def.identityParam && call.params[def.identityParam] === true`。
- `alwaysApprove`：`isLoginSensitive ⇒ 人工审批`，任何记忆、任何非 emergency 策略不得豁免
  （emergency 下更严，见 §4.3 记忆休眠）。
- 执行面在每次 `browser.act` 调用里**必须**带 `withIdentity`（未登录浏览为 false）；
  缺失视为 true（fail-closed），治理在 decision.reason 记 `identity_param_missing`。

### 2.5 spend 参数契约与台账写入

- 档位判定为 `spend` 时，`evaluate()` 先校验 `params` 含
  `amountCents(int>0) / currency(ISO4217 三字母) / category(string)`；缺失或类型错 ⇒
  `deny("spend 参数契约不满足")`——**钱都算不清的事不进入审批**，也不给台账留脏数据。
- 台账写入者是治理自己（§8 `resolveExecution`）：spend 调用执行成功 ⇒ 插
  `kind='charge'` 行；审批通过但执行失败 ⇒ 插 `kind='void'` 冲账行（负数金额），
  供人工核账。"执行成功但实际未扣款/部分扣款"的修正走 Web 人工补录
  （`recordSpendAdjustment`），MVP 不做自动对账。

### 2.6 目录语义与冲突规则

一次调用命中多个条目取**最高档**；`upgrade` 解析：把 `JSON.stringify(call.params)`
作小写字符串，`whenContains` 任一子串命中 ⇒ 档位提至 `upgrade.tier`；`tierHint` 只可提档。
`rules.yml` 自定义规则只能收紧：

```yaml
rules:
  - match: { tool: "net.post", urlHost: "*.github.com" }
    decision: approve          # allow→approve 之类降档在加载时被拒绝并告警
    reason: "对外仓库写入需人看"
```

---

## 3. 审批状态机与双通道裁决

### 3.1 决策入口与 evaluate 伪码

```ts
// src/governance/gate.ts —— 控制面唯一入口
export interface GovCtx {
  dotId: string;
  taskRef: { taskId: string; eventId?: string; journalStepId: string };
  emergency: boolean;          // 来自 ModelRouter（§S5）；治理在 emergency 变更时自行刷新
}
export type Decision =
  | { kind: "allow"; decisionId: string; brief: PrecheckBrief }
  | { kind: "review_pass"; decisionId: string; brief: PrecheckBrief } // 审查通过视同 allow
  | { kind: "review_approve"; approvalId: number }   // 审查器判危 → 转人工
  | { kind: "approve"; approvalId: number }          // 挂起，等双通道之一裁决
  | { kind: "deny"; decisionId: string; reason: string };

export async function evaluate(ctx: GovCtx, call: ToolCall): Promise<Decision>;

export interface ToolCall {
  callId: string;              // == journal 步骤 id（接缝 S1）
  tool: string;                // 与 tools.yml 登记名一致
  params: Record<string, unknown>;
  tierHint?: ToolTier;         // 调用方自报档（只用于提档校验，不能降档）
}
```

伪码（rev2 补：幂等重入、登录态谓词、upgrade 解析、spend 校验）：

```
def = catalog[call.tool]
if !def                          → deny("工具未登记")
if def.tier=='spend' && !spendContractOk(params) → deny("spend 参数契约不满足")
tier = max(def.tier, upgradeHit(def, call) ? def.upgrade.tier : def.tier, tierHint)
upgradeHit: lc = lowercase(JSON.stringify(call.params)); 任一 w in def.upgrade.whenContains
            使 lc.includes(w) ⇒ true

// —— 幂等重入（评审缺口#11）：先查活动单，绝不重复开单 ——
open = SELECT * FROM approvals WHERE journal_step=call.callId
       AND status IN ('pending','approved','executing')
if open:
    if open.status=='pending'  → return approve(open.id)        // 原样返回同一单
    if open.status=='approved' → return claimAndAllow(open)     // 已批未执行：认领后放行
    if open.status=='executing'→ return deny("execution in flight")  // 竞态防御
terminal = SELECT * FROM approvals WHERE journal_step=call.callId
           AND status IN ('rejected','expired','revoked')       // 至多一张
if terminal:
    audit("reentry_after_terminal", old=terminal.id)            // 出现即 bug 信号：
    return deny("step already terminal: "+terminal.status)      // 控制面不该重放终态步

if tier == "dangerous" && emergency        → deny("应急模式冻结危险操作")
if isLoginSensitive(def, call)             → a=insertApproval(…, reason="login-sensitive"); return approve(a.id)
if tier == "read" && !needsReview(call)    → allow(brief=none)   // 快速路径
rule = matchRules(tier, call)              // §4：rules.yml + endpoint_grants + approval_rules
if rule → rule.decision=="allow" ? allow(fromRule(rule)) : approve(insertApproval(rule-hit))
base = (emergency ? merge(EMERGENCY_POLICY, policy)[tier] : policy[tier])
switch base:
  allow   → allow
  review  → pre = precheckModel(call, goalDigest, ctx)     // §5.1；含 30s→45s 与降级矩阵
            pre.kind=="degraded_write" ? allow(reviewSkipped) :
            pre.verdict=="safe" ? allow(review=pre) : approve(insertApproval(pre))
  approve → a = insertApproval(pending); return approve(a.id)
  deny    → deny
每个出口都 INSERT decisions(...)（§7）并 audit("decision")
```

`insertApproval` 内 seq 生成（评审缺口#7）：与 INSERT 同一 `BEGIN IMMEDIATE` 事务内
`UPDATE gov_seq SET value=value+1 WHERE name='approval' RETURNING value`——
`gov_seq` 是独立计数表，**不随 90 天清理删除**，seq 跨清理单调。

### 3.2 审批单状态机（`approvals.status`）

```
                 ┌────────────┐
   insert ─────▶ │  pending   │
   Approval      └─────┬──────┘
      ┌────────────┬───┴────────┬─────────────┐
      ▼            ▼            ▼             ▼
 ┌─────────┐ ┌──────────┐ ┌─────────┐  (pending_until 过, cron)
 │ approved│ │ rejected │ │ expired │ ◀── expirePending()
 └────┬────┘ └──────────┘ └─────────┘
      │  claim（执行前原子认领，接缝 S1）
      ▼
 ┌───────────┐        ┌──────────┐
 │ executing │──────▶ │ executed │
 └─────┬─────┘        └──────────┘
       │ revoke 仅在 executing 前可达；执行中不可逆
       ▼
 ┌─────────┐   执行失败 → ┌────────┐
 │ revoked │              │ failed │（failed 不回退状态，只记审计+台账冲账）
 └─────────┘              └────────┘
```

合法迁移表（代码内 `TRANSITIONS: Record<Status, Status[]>`；非法迁移抛错并记审计
`illegal_transition`）：

| from | to | 触发者 |
|---|---|---|
| pending | approved / rejected | `decide()`（Web/TG/CLI 三通道归一入口） |
| pending | expired | cron `expirePending()` |
| approved | executing | 执行面 `claim()`（CAS 更新） |
| approved | revoked | `revoke()`（仅 approved 未认领时） |
| executing | executed / failed | `resolveExecution()` |

> **裁决即终局**：rejected/expired 不可被另一通道翻案，也不可被主人迟到回复复活
> （属主声明 §0.2；surfaces.md 的"过期后回复转 decided"与本规则冲突，O1 提请仲裁）。
> 要重做必须由新的工具调用/新的 synthetic 请求产生新审批单。
> executing 之后不接受 revoke——不可逆操作的安全边界在认领之前。

#### 3.2.1 surfaces 4 态 → 治理 8 态投影（供仲裁对照）

| surfaces.status | 对应治理状态 |
|---|---|
| pending | pending |
| decided | approved ∪ rejected（细分在 decided 字段，不再设独立状态） |
| expired | expired |
| cancelled | revoked（主人主动撤销）；若指"任务被取消联动"，由控制面在取消任务时调 `revoke()` 或 `decide(reject)`，治理不感知任务取消本身 |

surfaces 的 TTL 60 分钟若被采纳为全局值，只改 `GOV_DEFAULTS.approvalTtlMs` 一处——
TTL 数值可谈，**列与状态机不可谈**。

### 3.3 裁决接口与"先到先得"冲突规则

```ts
export type Verdict = "approve_once" | "approve_remember" | "reject";

export async function decide(
  approvalId: number,
  channel: "web" | "telegram" | "cli",
  verdict: Verdict,
  actor: string,               // "主人" 或 owner 标识，写审计
  note?: string,               // rev2：主人补充指令（评审缺口#15），≤500 字符，
): Promise<{ ok: boolean; finalStatus?: Status; reason?: string }>;
```

`note` 存入 `approvals.note`，经 `onApprovalSettled(taskId, ok, {note})` 元数据回到控制面，
由主循环注入恢复执行的步骤上下文（"批准，但只跑 dry-run"这类附条件指令的承接通道）。
治理**不解析** note 语义——附条件的强制执行属阶段三，MVP 仅保证传达。

冲突规则（核心设计决策，一条 SQL 实现）：

1. **单一权威**：所有通道都调 `decide()`；Web/Telegram/CLI 适配层不得自行 UPDATE approvals。
2. **先到先得 = SQLite 单写者事务**：
   ```sql
   BEGIN IMMEDIATE;
   UPDATE approvals
      SET status=@to, decided_by=@ch, decided_at=@now, note=@note,
          final_params_json=@params
    WHERE id=@id AND status='pending';      -- 条件更新
   -- changes()==0 ⇒ 已被其他通道/超时裁决，本次为 late decision
   COMMIT;
   ```
3. **迟到裁决不报错、只记账**：late 的 decide 返回
   `{ ok:false, finalStatus, reason:'已被 web 通道抢先批准' }`，
   写审计 `action='late_decision'`，**绝不**二次执行或状态回滚。
4. **提交事务后立即联动**（rev2，填评审缺口#4 的异步空白）：
   裁决成功落库后，治理**在 decide() 调用栈内**依次执行
   `hooks.settle(taskId, approvalId, ok)`（§8.2），由控制面负责恢复主循环或调用
   `journal.skipStep`——治理不直写 journal。expirePending 同理：扫描事务提交后逐条调
   `hooks.settle(taskId, id, false)`。因此"主循环让位后谁推进"= 治理钩子 → 控制面，
   无悬空事件。
5. **用户可感知**：`approval:decided` 事件广播 → Web 卡片置灰显示最终状态；
   TG 侧对 `tg_message_id` editMessage"已由 X 通道裁决"。
6. **认领竞态**：approved 后执行面 `claim()`（条件 UPDATE `WHERE status='approved'`）
   原子认领；revoke 与 claim 竞态同一模式——**谁先提交谁赢**。revoke 抢先则
   `hooks.settle(taskId, id, false, {revoke:'pre-claim'})`，控制面将 journal 步标
   `skipped_by_revocation`（S1）。
7. **批量命令竞态**：TG `approve all` 展开为逐条条件 UPDATE，只对当时仍 pending 的生效。

#### 3.3.1 通道 decision 枚举 ↔ 治理 verdict 映射（供 surfaces 对齐）

| surfaces | 治理 verdict |
|---|---|
| approve | approve_once |
| approve + remember（新按钮，见 §3.5） | approve_remember |
| deny | reject |
| answered（question 单的回答） | approve_once + note=回答文本 |

surfaces 的 decision 枚举缺 `approve_remember` 是缺口：记忆授权必须有一个落点；
本 rev 定义 Web 卡片"批准并记住"按钮（弹规则预览确认框）与 API `POST /approvals/:id/decide`
body `{verdict:"approve_remember", note?}`。TG 通道仍**禁用** approve_remember（§3.4）。

### 3.4 Telegram 协议（唯一寻址体系）

通知文案（`renderTgNotice` 生成，交互面发送）：

```
⚠ 审批 AP-#12 [D3] 档位:spend
任务: 在 X 站购买 API 额度
工具: browser.purchase {amountCents: 2000, currency: USD, category: api_credit}
理由: spend 档一律人工
回复: y 12 批一次 · d 12 拒 · q 12 详情（也可直接回复本消息）
批量: l 待批列表 · all 全部批准（仅 tier≤browser，spend/dangerous 除外，emergency 禁用）
补充: 任何裁决可附备注 "y 12 | 只跑dry-run" —— 竖线后文本作为 note 传达给 Agent
（应急模式提醒：登录态浏览器操作此刻全部强制人工）
```

- `AP-#<seq>` 即 surfaces 的 `ident` 形态；**权威键是 `seq`**（数字），
  `ident` 只是显示包装；InlineKeyboard 的 `callback_data` 用
  `g:<approvalId>:y` / `g:<approvalId>:d`（approvalId 是主键，回调不需要再解析文本）。
- `resolveTelegram(text, replyToMsgId?, callbackData?)` 解析优先级：
  callbackData（结构化，最稳）→ reply 到审批通知（`tg_message_id` 反查 approvalId）→
  文本指令。**别名表**（两模块语法统一，评审缺口#2）：
  `y|yes|a|approve|/yes N`→approve_once；`d|no|deny|/no N`→reject；
  `q|info|/info N`→详情；`l|list`；`all`；`/answer N <文本>`→question 单的
  approve_once+note。`approve_remember` 在 TG **禁用**：规则授权须在 Web 点
  "批准并记住"，强制展示规则预览——防手机误触形成持久授权。
- 无法解析：不猜测，回"未识别的审批指令"+pending 列表。
- 超时与提醒（rev2 补齐列，评审缺口#9）：`expirePending()` cron 每 5 分钟扫
  `status='pending' AND pending_until < now` → expired（随后逐条 hooks.settle）。
  提醒扫描：`reminded_at IS NULL AND pending_until < now+1h` → 重发一次并回填
  `reminded_at=now`，**不刷新 pending_until**（防刷屏续命），5 分钟周期下不会重复发。

### 3.5 Web 卡片接口（交互面渲染，本模块供数据）

```ts
export interface ApprovalView {
  id: number; seq: number; kind: ApprovalKind; tier: ToolTier | null;
  status: ApprovalStatus;
  summary: string;            // ≤120 字，含脱敏后 params 摘要
  fullParams: unknown;        // 渲染前再脱敏一遍
  reason: string; riskBrief?: PrecheckBrief;
  expiresAt: string; remindedAt?: string;
  taskRef: GovCtx["taskRef"];
  subject?: SyntheticSubject; // §3.6：非工具单的主语描述
}
export function listPending(limit = 50): PendingView[];
export async function getApproval(idOrSeq: number): Promise<ApprovalView>;
```

按钮 ↔ verdict：批准一次=`approve_once`、批准并记住=`approve_remember`（规则预览确认）、
拒绝=`reject`；dangerous 与 spend 单额外要求勾选"我确认"；全部按钮支持附 note 输入框。

### 3.6 非工具审批单（synthetic / question）

`approvals.kind ∈ { 'tool_call' | 'synthetic' | 'question' }`。两类新 kind 的字段约束
（`tool/tier/journal_step` 对 tool_call 必填，其余可空，DDL CHECK 强制，评审缺口#6）：

| kind | subject 例 | reason 例 | 裁决语义 |
|---|---|---|---|
| synthetic `recon_candidate` | `{model:'free.xx/yy', baseUrl, license, sourceUrl}` | "CONTEXT:11 接入必须主人批准" | approved 后治理发 `approval:decided{subject.kind:'recon_candidate', id, verdict}`，ModelRouter 订阅后自行接入/放弃；**永不生成记忆**，不受规则影响 |
| synthetic `emergency_override` | `{reason:'all-models-down', candidatePool}` | 应急覆盖授权 | router.onApprovalResult('emergency_override') 即此事件的消费端 |
| synthetic `side_effect_unknown` | `{taskId, step}` | 控制面 forceApproval 触发 | 批准后控制面重放该步；拒绝=skip |
| question | `{prompt, options?}` | Agent 主动提问 | verdict=approve_once + note=回答（§3.3.1 映射） |

签发接口（§8 `forceApproval`）复用同一状态机、同一双通道、同一先到先得规则——
治理不为非工具主语造第二套流程。`uniq_open_step` 仅约束 `kind='tool_call'`
（部分索引带 `AND journal_step IS NOT NULL`），非工具单幂等键由 `subject_key`
列提供（同 subject_key 至多一张活动单，侦察候选按模型名去重）。

---

## 4. 持久化记忆：已批端点与已批规则

### 4.1 两个概念

| 概念 | 粒度 | 来源 | 适用档位 |
|---|---|---|---|
| `endpoint_grants` | 单端点（origin / 路径前缀） | `approve_remember` 派生 | read / write_file / browser |
| `approval_rules` | 结构化条件（工具+参数谓词） | `approve_remember` 派生 | 同上；dangerous/spend/synthetic 永不 |

`spend` 档两个都不适用：每次花钱必是独立人工决定（安全默认，O2 提请主人确认）。

### 4.2 规则键派生

`approve_remember` 时 `deriveRule(tier, call)` 生成，Web 卡片先展示预览、确认才落库：

```
fs.write  /dot/home/notes/x.md → key = "rule:fs.write:path=/dot/home/notes/*"
net.post  https://api.x.com/v1/jobs → key = "grant:api.x.com:/v1/*"
browser.act url=https://x.com/home → key = "rule:browser.act:host=x.com,actions=navigate,click"
                                     且仅当 withIdentity=false 才可派生（登录态永不入记忆）
兜底：无法稳定派生 → 仅记 origin 级，宁粗勿漏；派生失败 → 退化为 approve_once
```

### 4.3 匹配与命中语义

```ts
export function matchMemory(tier: ToolTier, call: ToolCall):
  | { kind: "allow"; source: "rule"|"grant"; refId: number } | null;
```

- 命中即 `allow`，decision 带 `fromRule=refId`，审计可回溯"哪条记忆放行"；
  同时 `UPDATE hits=hits+1, last_hit_at=now`。
- `expires_at`（默认 90 天）或主人在 Web"记忆"页撤销即失效。
- 记忆按 tier 分桶：read 记忆不放行 browser 调用。
- **登录态调用永不命中记忆**（`isLoginSensitive ⇒ 跳过 matchMemory`，§2.4）。
- emergency 下 browser 记忆休眠（`emergency 期间 matchMemory 对 browser 档直接返回 null`），
  emergency 解除即恢复。

### 4.4 与收紧规则的优先级

`rules.yml`（人工收紧）> 记忆（历史放宽）。记忆永远不能推翻人工规则。

### 4.5 记忆的安全阀

- 每 Dot 每档位记忆上限 50 条，超出按 LRU（`last_hit_at`）自动 expired，防授权沉积。
- Web"记忆"页 + CLI `dotd memory ls/revoke <id>` 全量可见可撤。
- 派生规则文本必须出现在 Web 卡片确认框与审批通知预览里，保证知情。

---

## 5. 执行前审查 / 执行后审查

### 5.1 执行前审查（precheck）

```ts
export async function precheckModel(
  call: ToolCall, goalDigest: string, ctx: GovCtx
): Promise<{ verdict: "safe" | "risky"; reason: string }>;
```

走双轨路由之**低智能轨**（本地 Colibrì/Ollama，CONTEXT `已定:27`），接口由模型路由提供
（`router.lowIntelligence.complete(messages)`，§S5）。

#### 5.1.1 容量核算（rev2 回应评审缺口#12）

按 CONTEXT `机器约束:36`（OLMoE ~7 tok/s，单请求并发即排队）：

| 项 | 预算 |
|---|---|
| goalDigest | 调用方截断 ≤ 800 字节（≈250 tok） |
| 脱敏参数 | 截断 ≤ 1.5 KB（≈450 tok） |
| 提示模板 | ≈150 tok |
| 输出 | 行协议非 JSON：`S|R|理由≤20字`，max_tokens=40（≈30 tok 解析后 ≤15） |
| 合计 | 输入 ≈850 tok + 输出 ≈30 tok |

解码 30 tok ÷ 7 tok/s ≈ 4.3s；prefill 850 tok 按经验 2–4 倍于解码速率 ≈ 20–40s（内存吃紧
时更慢，CONTEXT 明言 Colibrì"尽力而为"）。**总预算 45s**（`precheckTimeoutMs: 45_000`，
rev2 自 30s 上调；评审指出 30s 在并发下实测 32s+ 必超时，属实）。输出协议压到行格式
是为把解码时间让给 prefill——这是本设计唯一能省的变量。

#### 5.1.2 超时降级矩阵（自适应，评审要求给出机制）

治理为低智能轨维护熔断：滚动窗口 10 分钟内连续 5 次超时/不可用 ⇒ `reviewDegraded=true`
（开 15 分钟，半开探测恢复）。降级期间 review 档不再涌向人工审批，按档位处理：

| tier | 正常 | degraded 非应急 | degraded 且 emergency |
|---|---|---|---|
| write_file | review→allow | **allow + `reviewSkipped=degraded`**（决策落 decisions 表，Web 可回放复核） | allow + reviewSkipped（emergency 的 write_file 本就是 review，审查器没了就退化为常态 write_file 行为） |
| browser | review→allow | **approve（人工）** | approve（人工） |
| browser+登录态 | 恒 approve | 恒 approve | 恒 approve |

设计原则：降级 fail-open 只给**可逆档**（/dot/home 内写）；外部副作用（browser）审查器
缺席时宁可人工，也不静默放行。应急触发常伴内存吃紧（netfuzz 负载 + Colibrì 不可靠），
此矩阵保证 write_file 不洪水审批，browser 洪水上限 = 任务数而非步数——同任务连续
browser 审批合并：同一 `taskId` 5 分钟内第 2 张起 pending 单复用同一 TG 消息批量卡片
（`batch_ref` 列），主人逐条或 `all` 处理，不各自发新消息刷屏。

### 5.2 执行后审查（post-review）

```ts
export async function postReview(
  ctx: GovCtx, call: ToolCall, resultDigest: string, decisionId: string
): Promise<"ok" | "suspicious" | "quarantine">;
```

触发条件（非每步全审，吞吐现实）：`tier >= browser`，或 result 含 URL/金额/凭据样式
（正则嗅探），或 call 属 `browser.act`。

流程：
1. `sanitize()` 剥 cookie/token/API key/卡号（§7 常量表）→ 截断 2KB。
2. 低智能模型三分类（同上协议，`OK|SUS|QUAR|理由≤20字`）。**审查器不可用时记 `suspicious`
   不阻断**——执行已发生，后审定位是告警与隔离，不是回滚；后审**不受降级矩阵约束**，
   永不 fail-open 为 ok。
3. `suspicious`：写审计 + Web 黄标，不影响任务流。
4. `quarantine`：见 §5.4。
5. 提示注入嗅探：result 含命令样文本且 verdict≠ok ⇒ `UPDATE decisions SET
   injection_suspect=1`（持久列，评审缺口#10），作为阶段三 invisible_playwright 数据源。

### 5.3 decisions 表：decisionId 的落库

`Decision` 各出口的 `decisionId`（ULID `dec_…`）**每次评估先落 `decisions` 表**，
`postReview` 以 `decision_id` 回写后审结论，audit 以 `decision_id` 关联，
崩溃发生在 allow 与执行之间时，journal 重放的 `callId` 可反查上一条 decisions 行
（`journal_step` 索引）恢复 brief 与后审义务。

### 5.4 quarantine 的持久化与解除（评审缺口#5）

- `quarantines` 表（§7）：dot_id、reason、decision_id、approval_id（可空）、status
  ∈ {active, lifted}。postReview 判 quarantine ⇒ **先 INSERT 成功才发事件**。
- 控制面承接（进程内直调，不依赖事件订阅存活）：`isQuarantined(dotId): boolean`，
  控制面调度器**每次出队前同步查询**——daemon 重启后表仍在，隔离不丢，被隔离 Dot
  不会复跑。`governance:quarantine` 事件只是 UI/通知加速器。
- 解除：`liftQuarantine(dotId, actor)`（Web"解除隔离"按钮 / CLI `dotd quarantine lift`），
  置 lifted + 审计 + 事件 `governance:quarantine_lifted`；控制面收到后可经
  `hooks.resumeDotQueue(dotId)` 恢复（该钩子要求控制面提供 per-dot 队列暂停/恢复
  语义——若控制面只有 per-task cancel，O6 提请仲裁补齐）。
- 隔离时经路由求救通道发 TG 通知（复用 §S5）。

---

## 6. 审计日志与保留

只追加，所有治理动作唯一落点；Web"审计"页与 CLI `dotd audit tail/replay` 只读展示。

### 6.1 动作枚举

```ts
export type AuditAction =
  | "decision"            // evaluate 每次产出 Decision（关联 decision_id）
  | "approval_created" | "approval_decided" | "late_decision"
  | "approval_expired" | "approval_revoked" | "approval_claimed"
  | "reentry_after_terminal"           // §3.1 重入踩到终态：bug 信号
  | "memory_created" | "memory_revoked" | "memory_hit" | "memory_expired"
  | "precheck" | "postreview" | "precheck_degraded"
  | "spend_recorded" | "spend_voided"
  | "emergency_on" | "emergency_off"
  | "quarantine" | "quarantine_lifted"
  | "catalog_reloaded" | "illegal_transition";
```

### 6.2 保留上限与回收（贴合 CONTEXT `机器约束:37`；rev2 修列，评审缺口#9）

- 在线窗口：`max(90 天, 20000 行)`。cron `compactAudit()` 每日：
  1. 以 **id 区间**为归档单位（不再用 chunk_id 分组——audit_log 无此列，改为
     `SELECT min(id),max(id),count(*) FROM audit_log WHERE ts < cutoff GROUP BY`
     每 ≤10MB 一段；`audit_archive` 存 `min_id/max_id/rows/bytes/sha256/file`）；
  2. 导出 `audit-<minid>-<maxid>.jsonl.gz` + sha256 入库；
  3. `DELETE FROM audit_log WHERE id BETWEEN @min AND @max` 同事务提交；
  4. 归档总量 ≤ `DOTD_AUDIT_ARCHIVE_MB`（默认 200MB），超限删最旧文件+manifest 行。
- 表清理（90 天）仅限终态行且**无被引用**：`spend_ledger.approval_id`、
  `audit_log.approval_id` 指向的行保留（LEFT JOIN 反连接删除）。
- 截断标记：`details` 超 2KB ⇒ 存截断文并置 `details_truncated=1`（实列，评审缺口#9）。
- `approvals`/记忆表终态行同 90 天清理（同上引用豁免）；`decisions` 与 `quarantines`
  的 active 行永不清理，lifted/expired 满 90 天清。

---

## 7. 数据结构全量 DDL 与类型

```sql
-- src/governance/schema.sql —— 治理迁移包。
-- 库文件：由环境变量 DOTD_DB_PATH 指向控制面属主持有的唯一库（WAL 模式），
-- 本模块不硬编码文件名；四份文档库名不一致（O5），迁移版本注册归控制面 db 模块。

CREATE TABLE gov_seq (
  name  TEXT PRIMARY KEY,                        -- 'approval'
  value INTEGER NOT NULL DEFAULT 0               -- 与 insert 同事务 UPDATE+RETURNING，跨清理单调
);

CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY,             -- rowid 可复用：展示与 TG 寻址一律用 seq（§3.4）
  seq           INTEGER NOT NULL UNIQUE,         -- 由 gov_seq 生成，AP-#<seq> 即 surfaces 的 ident
  kind          TEXT NOT NULL DEFAULT 'tool_call'
    CHECK (kind IN ('tool_call','synthetic','question')),
  subject_key   TEXT,                            -- 非工具单幂等键（如 'recon:free.xx/yy'）
  subject_json  TEXT,                             -- SyntheticSubject：非工具单的主语（§3.6）
  dot_id        TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  event_id      TEXT,
  journal_step  TEXT,                            -- tool_call 必填 == ToolCall.callId（S1）
  tool          TEXT,
  tier          TEXT CHECK (tier IN ('read','write_file','browser','spend','dangerous')),
  params_json   TEXT NOT NULL,                   -- sanitize 后
  summary       TEXT NOT NULL,                   -- ≤120 字卡片文案
  reason        TEXT NOT NULL,                   -- policy:spend / precheck:risky / login-sensitive / force:side_effect_unknown …
  risk_brief    TEXT,                            -- PrecheckBrief JSON
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired','executing','executed','failed','revoked')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  pending_until TEXT NOT NULL,                   -- created_at + TTL（默认 24h，可仲裁改 60min）
  reminded_at   TEXT,                            -- 过期前 1h 提醒一次后回填（§3.4）
  decided_at    TEXT,
  decided_by    TEXT CHECK (decided_by IN ('web','telegram','cli') OR decided_by IS NULL),
  note          TEXT,                            -- 主人补充指令（§3.3，≤500 字符）
  tg_message_id INTEGER,                         -- 通知消息回填
  batch_ref     TEXT,                            -- 同任务 5min 批量卡片合并（§5.1.2）
  final_params_json TEXT,                        -- 认领时固化（S2）
  CHECK (kind != 'tool_call' OR (tool IS NOT NULL AND tier IS NOT NULL AND journal_step IS NOT NULL))
);
CREATE INDEX idx_approvals_pending ON approvals(status, pending_until) WHERE status='pending';
CREATE INDEX idx_approvals_step    ON approvals(journal_step);
CREATE UNIQUE INDEX uniq_open_step ON approvals(journal_step)
  WHERE kind='tool_call' AND journal_step IS NOT NULL
        AND status IN ('pending','approved','executing');   -- 同一步至多一张活动审批单
CREATE UNIQUE INDEX uniq_open_subject ON approvals(subject_key)
  WHERE subject_key IS NOT NULL
        AND status IN ('pending','approved','executing');   -- 非工具单幂等

CREATE TABLE decisions (
  id               TEXT PRIMARY KEY,             -- 'dec_<ulid>'
  ts               TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id           TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  journal_step     TEXT,
  call_id          TEXT,                          -- == journal_step（冗余，重入反查）
  kind             TEXT NOT NULL CHECK (kind IN ('allow','review_pass','approve','deny')),
  tier             TEXT,
  tool             TEXT,
  params_json      TEXT,                          -- sanitize 后
  reason           TEXT,
  review_skipped   INTEGER NOT NULL DEFAULT 0,   -- §5.1.2 降级放行标记
  from_memory      INTEGER,                       -- 命中记忆的行 id（追溯放行依据）
  approval_id      INTEGER REFERENCES approvals(id),
  precheck_json    TEXT,
  postreview       TEXT CHECK (postreview IN ('ok','suspicious','quarantine') OR postreview IS NULL),
  postreview_json  TEXT,
  injection_suspect INTEGER NOT NULL DEFAULT 0    -- §5.2.5，持久列（评审缺口#10）
);
CREATE INDEX idx_decisions_step ON decisions(journal_step, ts);

CREATE TABLE approval_rules (
  id          INTEGER PRIMARY KEY,
  dot_id      TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('read','write_file','browser')), -- spend/dangerous 禁入
  rule_key    TEXT NOT NULL,
  matcher     TEXT NOT NULL,                     -- JSON: {tool, urlHost, pathGlob, actions…}
  text        TEXT NOT NULL,                     -- 人读文本，确认框展示
  source_approval INTEGER NOT NULL REFERENCES approvals(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);
CREATE UNIQUE INDEX uniq_rule ON approval_rules(dot_id, tier, rule_key) WHERE status='active';

CREATE TABLE endpoint_grants (
  id         INTEGER PRIMARY KEY,
  dot_id     TEXT NOT NULL,
  origin     TEXT NOT NULL,
  path_glob  TEXT NOT NULL DEFAULT '/*',
  tier_ceiling TEXT NOT NULL CHECK (tier_ceiling IN ('read','write_file','browser')),
  source_approval INTEGER NOT NULL REFERENCES approvals(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dot_id, origin, path_glob, tier_ceiling)
);

CREATE TABLE quarantines (
  id          INTEGER PRIMARY KEY,
  dot_id      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  approval_id INTEGER REFERENCES approvals(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  lifted_by   TEXT,
  lifted_at   TEXT
);
CREATE UNIQUE INDEX uniq_quarantine ON quarantines(dot_id) WHERE status='active';

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id       TEXT,
  task_id      TEXT,
  journal_step TEXT,
  decision_id  TEXT,                               -- 关联 decisions（评审缺口#10）
  approval_id  INTEGER,
  actor        TEXT NOT NULL,                      -- 'agent' | 'owner' | 'system'
  channel      TEXT CHECK (channel IN ('web','telegram','cli','system') OR channel IS NULL),
  action       TEXT NOT NULL,                      -- §6.1（库层不加 CHECK，增枚举免迁移）
  tier         TEXT,
  tool         TEXT,
  decision     TEXT,                               -- allow/approve/reject/deny/expired…
  reason       TEXT,
  details_json TEXT,
  details_truncated INTEGER NOT NULL DEFAULT 0     -- §6.2 实列（评审缺口#9）
);
CREATE INDEX idx_audit_ts   ON audit_log(ts);
CREATE INDEX idx_audit_task ON audit_log(task_id, ts);
CREATE INDEX idx_audit_step ON audit_log(journal_step);
CREATE INDEX idx_audit_dec  ON audit_log(decision_id);

CREATE TABLE audit_archive (
  id         INTEGER PRIMARY KEY,
  file       TEXT NOT NULL,                        -- 相对 <数据目录>/audit-archive/
  min_id     INTEGER NOT NULL, max_id INTEGER NOT NULL,   -- id 区间（替代 chunk_id）
  min_ts     TEXT NOT NULL,  max_ts TEXT NOT NULL,
  rows       INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE spend_ledger (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id       TEXT NOT NULL,
  approval_id  INTEGER NOT NULL REFERENCES approvals(id),
  decision_id  TEXT REFERENCES decisions(id),
  category     TEXT NOT NULL,                      -- 'api_credit'|'purchase'|'donation'|'adjust' …
  amount_cents INTEGER NOT NULL,                   -- charge 正、void 负（CHECK 废除，见 §2.5）
  currency     TEXT NOT NULL,                      -- ISO4217
  kind         TEXT NOT NULL CHECK (kind IN ('charge','void','adjust')),
  note         TEXT
);
```

```ts
// src/governance/status.ts —— 与 CHECK 约束逐字一致（S3：交互面用同名联合）
export type ApprovalStatus =
  | "pending" | "approved" | "rejected" | "expired"
  | "executing" | "executed" | "failed" | "revoked";
export type ApprovalKind = "tool_call" | "synthetic" | "question";
export interface SyntheticSubject { kind: "recon_candidate" | "emergency_override"
  | "side_effect_unknown"; payload: Record<string, unknown> }

export const TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending:   ["approved", "rejected", "expired"],
  approved:  ["executing", "revoked"],
  executing: ["executed", "failed"],
  rejected: [], expired: [], executed: [], failed: [], revoked: [],
};
```

配置与上限常量：

```ts
// src/governance/config.ts（环境变量覆盖）
export const GOV_DEFAULTS = {
  approvalTtlMs: 24 * 3600_000,   // DOTD_APPROVAL_TTL_H；与 surfaces 的 60min 冲突 → O3 仲裁
  expireScanMs:  5 * 60_000,      // DOTD_EXPIRE_SCAN_MIN
  precheckTimeoutMs: 45_000,      // §5.1.1 容量核算结果
  precheckBudget: { goalBytes: 800, paramsBytes: 1500, maxOutputTokens: 40 },
  reviewFailThreshold: { windowMs: 600_000, fails: 5, openMs: 900_000 }, // §5.1.2 熔断
  auditRetentionDays: 90,         // DOTD_AUDIT_RETENTION_DAYS
  auditRetentionRows: 20_000,     // DOTD_AUDIT_RETENTION_ROWS
  auditArchiveCapMb: 200,         // DOTD_AUDIT_ARCHIVE_MB（C: 盘约束）
  chunkBytes: 10 * 1024 * 1024,
  memoryPerTierCap: 50,
  memoryDefaultExpiryDays: 90,
};
export const SANITIZE_PATTERNS: RegExp[] = [ /* cookie:、Authorization:、token 形态、
  13–19 位卡号、api key 形态… 入库与出图前各跑一遍 */ ];
```

---

## 8. 对外接口汇总（模块导出面）

### 8.1 治理导出给其他模块

```ts
// index.ts（src/governance）
export { evaluate, decide, claim, resolveExecution, revoke, forceApproval } from "./gate.js";
export { resolveTelegram, renderTgNotice } from "./channels/telegram.js"; // 交互面 TG 处理器调用
export { listPending, getApproval } from "./queries.js";                   // Web/CLI 读
export { precheckModel, postReview, sanitize } from "./review.js";
export { matchMemory, deriveRule, revokeMemory, listMemory } from "./memory.js";
export { expirePending, compactAudit, initSeq } from "./cron.js";
export { isQuarantined, liftQuarantine } from "./quarantine.js";            // §5.4
export { recordSpendAdjustment } from "./ledger.js";                        // §2.5
export function initGovernance(deps: GovDeps): void;                        // §8.2
export type { GovCtx, Decision, ToolCall, Verdict, ApprovalView, ApprovalStatus,
              ApprovalKind, SyntheticSubject, PrecheckBrief, ToolTier } from "./types.js";
```

`forceApproval`（控制面调用，承接 control-plane.md:333 的约定，评审缺口#4）：

```ts
export async function forceApproval(
  taskId: string,
  req: { kind: SyntheticSubject["kind"]; subject: Record<string, unknown>;
         reason: string; ttlMs?: number },
): Promise<{ approvalId: number }>;   // 同步签发 pending 单，走同一双通道
```

### 8.2 治理依赖（由控制面在 initGovernance 注入的钩子与通道）

```ts
export interface GovDeps {
  controlPlane: {
    setAwaitingApproval(taskId: string, approvalId: number): void;
    // evaluate 返回 approve 后、主循环让位前，由治理调用（= control-plane.md:469 约定）
    onApprovalSettled(taskId: string, approvalId: number,
                      ok: boolean, meta?: { note?: string; revoke?: string }): void;
    // decide 提交、expirePending 提交、revoke 抢先 claim 失败——全部在调用栈内触发（§3.3.4）
    resumeDotQueue(dotId: string): void;   // liftQuarantine 后调用（需控制面具备，O6）
  };
  journal: {                            // 只读：重入核对用；治理绝不写 journal
    stepExists(callId: string): boolean;
  };
  router: {                             // §S5
    lowIntelligence: { complete(msgs: Msg[]): Promise<string> };  // 45s 超时由治理控制
    on(event: "governance:emergency", cb: (p: {on:boolean}) => void): void;
    requestHelp(topic: string, view: ApprovalView | QuarantineView): void; // TG优先/email兜底
  };
  bus: EventEmitter;                    // daemon 内事件总线
}
```

主循环对 `onApprovalSettled(ok=false)` 的义务（契约声明）：调 `journal.skipStep(callId,
reason)` 并推进任务；`ok=true` 时恢复执行并以 `final_params_json`（+note 注入上下文）执行。
治理不直写 journal——职责边界（§1.2），但推进责任链完整：**evaluate 同步路径**与
**异步裁决/超时路径**都由治理在事务提交后调钩子，控制面是唯一的状态位与 journal 写手。

事件总线（接缝 S4）：

| 事件 | 载荷 | 消费者 |
|---|---|---|
| `approval:created` | ApprovalView | Web UI、Telegram 通知 |
| `approval:decided` | {id, seq, kind, subject?, verdict, status, channel, late?} | Web 置灰、TG editMessage；**kind=synthetic 时 ModelRouter 订阅**（侦察候选/应急覆盖，§3.6） |
| `governance:quarantine` | {dotId, decisionId, approvalId?} | Web 弹详情、TG 求救（仅为加速器；持久性靠 quarantines 表 + 出队前 isQuarantined 同步查询） |
| `governance:quarantine_lifted` | {dotId} | Web、控制面（配合 resumeDotQueue） |
| `governance:emergency` | {on: boolean} | ModelRouter 发出、本模块订阅并刷新策略 |

主循环执行序（每步）：

```
journal.beginStep(callId)
d = await evaluate(ctx, {callId, tool, params})
switch d.kind:
  allow / review_pass → 执行 → postReview 按 §5.2 → journal.endStep
  approve → controlPlane.setAwaitingApproval(taskId, d.approvalId)；主循环让出任务
            （裁决/超时/撤销后治理在调用栈内回调 onApprovalSettled，推进归控制面）
            恢复执行一律用 final_params_json + note，不复用内存旧参
  deny / (settle ok=false) → 控制面 journal.skipStep(reason) → 任务按失败/改道逻辑继续
```

---

## 9. 与其他模块的接缝假设（逐条，供仲裁）

- **S1 · 执行面/journal**：`ToolCall.callId == journal 步骤 id`，全局唯一，贯穿
  approvals.journal_step / decisions.journal_step / audit_log.journal_step。重入语义：
  同 callId 存在活动单 ⇒ evaluate 原样返回该单（pending）或认领放行（approved）；
  存在终态单 ⇒ deny + `reentry_after_terminal` 审计（控制面不得重放终态步）。
  `uniq_open_step` 部分索引 + `gov_seq` 生成 seq 是幂等三件套。满足 CONTEXT `参考:44`。
- **S2 · 执行面**：执行只认 `claim()` 后落库的 `final_params_json`；工具必须在 tools.yml
  登记（未登记 = deny，白名单制）；`browser.*` 工具必须带 `params.withIdentity`
  （缺失按 true，fail-closed，§2.4）；`spend` 工具参数必须满足
  `{amountCents, currency, category}` 契约，否则 evaluate 直接 deny（§2.5）；
  写文件路径限于 `pathPrefixes`。
- **S3 · 交互面 Web（surfaces.md 的整改要求，仲裁对象）**：surfaces 不得持有第二张
  审批权威表；其 `approval_response`/`deliver_state` 降级为"通知投递状态"附属表，
  外键指 `approvals.id`。`ident` = `AP-#<seq>`。decision 枚举必须补
  `approve_remember`（Web API 须有对应端点），`answered` 映射为 approve_once+note。
  过期"复活"功能若保留，只能实现为"重发提醒/TTL 加长"，不得改 expired 终态（§0.2、O1）。
  状态徽章、按钮枚举一律用本模块导出的 `ApprovalStatus/TRANSITIONS/ApprovalView`。
- **S4 · 交互面 Telegram**：入站文本/callbackData 整串交 `resolveTelegram()`
  （唯一写路径；alias 表 `y/yes/a//yes` 等均收，§3.4）；出站通知由 `renderTgNotice()`
  生成；callback_data 格式 `g:<approvalId>:<y|d>`；TG 层禁止绕过 decide() 改库；
  `tg_message_id`/`batch_ref` 由治理回填、交互面消费。
- **S5 · 模型路由**：治理只依赖三件事——(a) `governance:emergency` 事件；
  (b) `lowIntelligence.complete()` 调用通道（45s 超时 + §5.1.2 熔断降级归治理）；
  (c) `requestHelp()` 求救通道复用。ModelRouter 侧需：订阅 `approval:decided` 中
  `subject.kind ∈ {recon_candidate, emergency_override}`（即 model-router.md:589 的
  `approval.decided{kind:recon_candidate,id,approved}`，本模块以事件名+载荷字段满足其约定，
  approved ⇒ verdict=approve_once）；其 `onApprovalResult('emergency_override')` 即此事件。
- **S6 · 控制面/队列**：三函数对接（control-plane.md:469/508/333 约定全部落实）：
  治理调 `setAwaitingApproval(taskId, approvalId)` 与 `onApprovalSettled(taskId,
  approvalId, ok, meta)`；控制面调 `evaluate/forceApproval`、出队前调
  `isQuarantined(dotId)`、lift 后接收 `resumeDotQueue`（若控制面缺 per-dot 暂停语义 ⇒ O6）。
  `expirePending/compactAudit/initSeq` 注册进控制面统一调度器；journal.skipStep 只由
  控制面调用（§8.2）。
- **S7 · 记忆模块**：任务开始时提供 goalDigest（≤800B 截断约定，§5.1.1）；治理不读写
  /dot/home。
- **S8 · 数据库**：治理以 `schema.sql` 交付迁移包，经 `DOTD_DB_PATH` 注入唯一库
  （WAL）；库文件名与迁移版本注册归控制面属主（四文档四名不一致 ⇒ O5，本模块 rev2
  不押注具体路径）。BEGIN IMMEDIATE 单写者串行与连接池 synchronous=NORMAL 并存无冲突。

## 10. 遵守的 CONTEXT 约束清单

| CONTEXT 出处 | 本设计的落实 |
|---|---|
| `已定:11` 侦察接入必须主人批准 | §3.6 synthetic recon_candidate 审批单 + S5 事件回路 |
| `架构:18` TS 单进程 daemon + SQLite | 治理为进程内库；状态全在注入库的表内（§0.5/O5 路径待仲裁） |
| `架构:19` 治理四件套 | §2 分级、§3 状态机+双通道、§5 前后审查、§6 审计，逐项覆盖 |
| `架构:29` 应急模式收缩 | §2.1 EMERGENCY_POLICY + §2.4/§4.3 登录态强制人工与记忆休眠 |
| `机器约束:36` Colibrì ~7 tok/s、尽力而为 | §5.1.1 逐 token 容量核算；§5.1.2 熔断降级矩阵；后审永不 fail-open |
| `机器约束:37` C:/D: 盘小 | §6.2 90 天/2 万行 + 归档 200MB 上限 + 记忆 50 条上限 |
| `参考:43` OpenDots 审批卡片/前后审查 | §3.5 卡片模型、§5 前审 brief + 后审三分类 |
| `参考:44` journal 崩溃安全不重复执行 | S1：callId 贯通 + uniq_open_step + gov_seq；重入伪码显式分支 |
| `参考:46` 零遥测、数据自持有 | 审计/记忆/归档全在本地；sanitize 保证凭据不入库 |
| `分期:51` MVP CLI/Web 审批 | decide(channel=cli/web) 阶段一可用；TG 语法与 §4 记忆对应 `分期:52` 阶段二，接口阶段一即定型 |
| `已定:27` 双轨路由 | precheck/postReview 走低智能轨，人工裁决不依赖模型 |

## 11. 开放问题（提请主人/仲裁员拍板）

- **O1 过期复活**：surfaces.md 要 expired 后回复可转 decided，本设计定死终局（§0.2）。
  请仲裁：改 surfaces（建议，配 reminded_at 提醒已缓解 UX）或给治理加"宽限期重开单"语义。
- **O2 spend 记忆**：是否允许"月度额度内充值免审批"（需 spend_budgets 扩展）？现取"永不"。
- **O3 TTL 数值**：治理默认 24h，surfaces 默认 60min。数值仲裁一项即可（改 GOV_DEFAULTS），
  不影响结构。
- **O4 多主人/角色**：谁能批 spend/dangerous？单主人假设是否进阶段三。
- **O5 库文件路径**：control.db / db/main.db / ~/dotd/dotd.db / ~/.dotd/dotd.db 四说其一，
  请控制面属主裁定并广播，本模块经 DOTD_DB_PATH 适配任意结果。
- **O6 per-dot 隔离**：quarantine 语义要求控制面具备 per-dot 队列暂停/恢复；
  control-plane.md 现只有 per-task cancel，请仲裁补齐 API。
- **O7 `approve all` 边界**：现定 tier≤browser 且非 emergency；是否按规则键白名单化。
- **O8 审计归档体验**：超窗转 gz、在线只查近 90 天，是否接受。
- **O9 executing 后 revoke**：现定不可撤销（安全边界在认领前）；若执行面提供工具级
  中断，是否允许 revoke 尝试打断执行中任务。
- **O10 spend 台账精度**：charge/void 依赖参数契约与执行成败信号，无自动对账；
  "成功未扣款"靠人工 adjust 补录，是否够用。

---

## 12. 评审响应（rev2，逐条）

> 评审所引行号均针对 rev1 的 governance.md；其余模块引用（surfaces.md/execution.md/
> control-plane.md/model-router.md/memory.md）按评审原文核对，rev2 未改动那些文件。
> 本文件 modules/ 下各文档 rev2 均已存在，评审引用可信。

1. **审批表双头所有权与状态机冲突** → §0.1/§0.2 立"属主声明"：治理 approvals 表是裁决
   唯一权威，surfaces 的表降级为通知投递/deliver_state 附属表（S3）；§3.2.1 给出
   surfaces 4 态→治理 8 态投影映射供仲裁；TTL 60min vs 24h 定为纯数值问题（O3）。
   "expired 复活"冲突：治理**拒绝翻案**并列为 O1 提请仲裁，同时用 reminded_at 提醒机制
   （第 9 条）缓解其背后的真实 UX 诉求（迟到可见）。

2. **Telegram 协议两套不兼容** → §3.4 统一寻址：权威键 `seq`，`ident` 定义为其显示形态
   `AP-#<seq>`；设**别名表**同时收 `a/y/yes//yes N` 与 `d/no/deny`，callback_data 定为
   `g:<approvalId>:<y|d>`；`resolveTelegram` 声明为唯一写路径（S4）。decision 枚举缺口：
   §3.3.1 把 surfaces 的 approve/deny/answered 映射到 verdict，`approve_remember` 明确为
   surfaces Web API 必须补的端点（rev1"TG 禁用记住"的意图保留——只有 Web 有该按钮与规则
   预览确认框）。

3. **登录态识别两说各话** → 采纳 execution.md S5 的动态判定为唯一机制：`params.withIdentity`
   （§2.4），rev1 的静态 `loginSensitive` 标记**删除**；目录加载校验强制 browser.* 声明
   `identityParam`；字段缺失按 true fail-closed。§0.4 属主声明广播此裁定。

4. **控制面↔治理接口对不上** → `forceApproval(taskId,{kind,subject,reason})` 入导出面
   （§8.1）；`setAwaitingApproval/onApprovalSettled` 入 `GovDeps.controlPlane` 注入钩子
   （§8.2），evaluate 同步路径、decide 提交、expirePending 提交、revoke 竞态四条路径
   全部在调用栈内回调钩子（§3.3.4），"谁置 awaiting_approval、谁推进 skipStep 唤醒任务"
   有了明确答案：治理调钩子、控制面写 journal 与状态位（治理不直写 journal，§1.2）。

5. **quarantine 无持久化无解除接口** → 新增 `quarantines` 表（§7，postReview 判危先
   INSERT 再发事件）、`isQuarantined(dotId)` 同步查询（控制面**每次出队前**查，重启不丢、
   被隔离 Dot 不复跑）、`liftQuarantine()` 解除接口 + `governance:quarantine_lifted` 事件
   （§5.4）。§10 不再自夸"全部状态在表内"是空话——quarantine 现在是表内状态。
   控制面 per-dot 暂停语义缺口如实标注为 O6，不替对方发明 API。

6. **侦察候选/应急授权装不进表** → `approvals.kind ∈ {tool_call, synthetic, question}` +
   `subject_key/subject_json` 列（§3.6/§7），tool/tier/journal_step 改可空并以 CHECK
   约束"tool_call 必填"；`uniq_open_step` 改部分索引只对带 journal_step 的行去重，非工具
   单用 `uniq_open_subject`。S5 声明 ModelRouter 订阅 `approval:decided{subject.kind:
   'recon_candidate'|'emergency_override'}`，承接 model-router.md:589/564 两约定；
   §1.1 职责清单补第 2 条。

7. **seq 无生成机制** → 新增 `gov_seq` 表，`UPDATE value=value+1 RETURNING` 与 INSERT 同
   事务（§3.1 尾注/§7），计数表豁免于 90 天清理 ⇒ 跨清理单调；§7 注释明确"id rowid 可
   复用，展示与 TG 寻址一律用 seq"。

8. **tools.yml 示例非法 + zod 形状矛盾** → §2.2 改为合法嵌套映射
   `upgrade: {tier, whenContains:[…]}`，§2.3 zod 同步（rev1 的 `z.string()` 与 YAML
   object 的矛盾消除）；§3.1 伪码补 `upgradeHit` 解析定义（小写 JSON.stringify(params)
   子串匹配）——谁解析（治理加载器+evaluate）、怎么解析（子串表）都落实。

9. **§6.2/§3.4 伪码与 DDL 缺列** → chunk_id 废除，归档改 id 区间（audit_archive 存
   min_id/max_id，§6.2/§7）；补 `details_truncated` 实列；`pending_at` 笔误消除（表里
   一直是 created_at/pending_until，§3.4 扫描式改写为 `pending_until < now`）；新增
   `reminded_at` 列 + `IS NULL` 条件 ⇒ "过期前 1h 提醒一次"在 5 分钟周期下不重发。

10. **decisionId 无落库** → 新增 `decisions` 表（§5.3/§7）：每次 evaluate 出口落一行，
    postReview 结论回写 `postreview/postreview_json`，injection_suspect 成持久列，
    audit_log 补 `decision_id` 列与索引；allow 与执行之间崩溃时按 journal_step 反查。

11. **S1 幂等重入伪码不支持** → §3.1 伪码显式两分支：活动单存在 ⇒ 按状态返回同一单/
    认领放行/竞态 deny；终态单存在 ⇒ deny + `reentry_after_terminal` 审计（新枚举），
    §9/S1 边界说明"控制面不得重放终态步"。另 §3.4 批量卡片合并防洪水为增补，非本条。

12. **30s 预算 vs 7 tok/s 无核算** → §5.1.1 给出逐 token 推导（输入截断 goalDigest≤800B/
    params≤1.5KB、输出改行协议 max_tokens=40），预算上调至 45s 并说明依据；§5.1.2 新增
    熔断降级矩阵——review 模型 10min 内 5 次超时⇒degraded：write_file fail-open 为
    allow+reviewSkipped（可逆档），browser fail-closed 转人工（外部副作用档），并配
    同任务批量卡片合并限制人工洪水上限。应急+降级叠加行为逐格定义，不再空白。

13. **库文件名四处不一致** → 治理不再押注文件名：§7/§0.5/S8 统一经 `DOTD_DB_PATH` 注入
    控制面属主持有的唯一库，四说其一列为 O5 提请控制面属主裁定；并澄清
    synchronous=NORMAL 与 BEGIN IMMEDIATE 无冲突（§1.3/S8），撤掉 rev1"全部状态在
    control.db"的硬编码表述。

14. **spend_ledger 无写入者** → §2.5 定参数契约（evaluate 校验 amountCents/currency/
    category，不满足直接 deny）、写入者=治理 resolveExecution（charge 正/void 负）、
    人工补录 `recordSpendAdjustment`；表结构 kind 列区分三种、amount CHECK 相应放开；
    无自动对账的边界如实写入 O10。

15. **主人补充指令无处承接** → `decide(..., note?)` + `approvals.note` 列 +
    `onApprovalSettled(ok, meta.note)` 回传主循环上下文（§3.3）；surfaces 的
    approval_response.text 与 /answer 通道映射为 note 载荷（§3.3.1 answered⇒
    approve_once+note），治理不解析语义、附条件强制执行划阶段三——若仲裁砍掉 /answer，
    删除面也只是 note 的一个来源。
