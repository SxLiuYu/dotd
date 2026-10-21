# 126 条审批卡在 `executing`：诊断与清理方案

> 状态：**方案已备，未执行**。改数据要主人点头，这里只把事实和可回滚的做法摆清楚。
> 生成时间：2026-10-21
> 清单：`docs/acceptance/approvals-stuck-executing.json`（126 条全量，含 id/任务/工具/档位/时间）

## 一、现象

```
$ sqlite3 ~/.dotd/dotd.db "SELECT status,count(*) FROM approvals GROUP BY status"
executing|126
expired|9
```

**没有一条 `executed` / `failed`。** 也就是说审批流转只在两个中间态上停着。

## 二、为什么这确实是个 bug，而不只是"记录不好看"

`src/governance/gate.ts:372`：

```ts
return deny('execution in flight'); // executing：竞态防御
```

同一张审批单若再被触发，会因为停在 `executing` 而被**永久拒绝**。这不是脏数据，
是**功能坏死**：那些单子不可再认领、不可再裁决，只能作废。

## 三、根因

`resolveExecution()` 定义在 `src/governance/gate.ts:1508`，从
`src/governance/index.ts:24` 导出 —— 但**全项目无人调用**：

```
$ grep -rn "resolveExecution" src/runner/ src/control-plane/ src/daemon.ts
（空）
```

`claim()` 把审批从 `approved` 推到 `executing` 之后，契约上应该有人回报执行结果，
而那个"人"从来没接上。`tests/runner-main.test.ts` 里原本的注释甚至写明了这个前提：

> `// executing→executed 的终态回写归治理 decide/执行面回收（Runner 只负责执行前认领）`

一个从未被实现的"回收者"。

### 已修（本次，commit 6805176）

- `GovernanceApi` 增加 `resolveExecution`
- `daemon.ts` 接线到 `govResolveExecution`
- Runner 在审批续跑的工具执行完后回报；失败只记日志（不让已拿到的工具结果作废）

实测：

```
#136: pending → approved → executed   ✓
任务 tk_mvhzwsn4f4zoa6 → done
改前同位置：停在 executing（反向注入复现：actual 'executing'，测试 FAIL）
```

## 四、那 126 条怎么办

### 4.1 先确认它们已经"无害地旧了"

```
任务状态分布：done 124 / cancelled 2 / 其它 0
找不到对应任务的：0
```

**没有一条对应的任务还在跑。** 所以它们不影响调度，只是（a）审计上不完整，
（b）那张单子本身不可再被认领。

### 4.2 三种处理方式

| 方案 | 做法 | 代价 |
|------|------|------|
| A. 不动 | 留着当历史 | 审计表永久有 126 条无终态记录；查询要额外过滤 |
| B. 回填 `executed` | 视作"已执行"收口 | 语义上最接近事实（工具当时确实跑了）；但属于事后追认 |
| C. 标记 `expired` | 视作"过期作废" | 与已有 9 条一致；但掩盖了"它其实执行过" |

### 4.3 建议：B，且保留可回滚

理由：这些审批的工具调用**当时确实执行了**（任务都 done 了）。标 `expired` 会让
审计记录说"没执行"，与事实相反。`executed` 才是真实状态。

**回滚保证**：执行前先备份整张表。

```bash
# 1) 备份（这一步无副作用，随时可做）
cp ~/.dotd/dotd.db ~/.dotd/dotd.db.bak-$(date +%Y%m%d-%H%M%S)

# 2) 回填（只在确认备份存在后执行）
sqlite3 ~/.dotd/dotd.db <<'SQL'
BEGIN IMMEDIATE;
UPDATE approvals
   SET status = 'executed',
       note   = COALESCE(note, '') || ' [2026-10-21 历史回填：resolveExecution 此前从未接线，执行确已完成]'
 WHERE status = 'executing'
   AND id IN (SELECT id FROM approvals WHERE status='executing');
SELECT 'affected', changes();
COMMIT;
SQL

# 3) 校验
sqlite3 ~/.dotd/dotd.db "SELECT status,count(*) FROM approvals GROUP BY status"

# 4) 回滚（若判断有误，用备份整体还原）
# cp ~/.dotd/dotd.db.bak-YYYYMMDD-HHMMSS ~/.dotd/dotd.db
```

**注意**：第 2 步改写 126 行审批状态。按当前工作守则，这类改动要主人明确同意
才执行；本文只提供脚本。

## 五、顺带发现的一个测试盲区（已修）

`clipForFeishu` 的单测全绿，但把调用点改成不裁剪，**一条都不会失败** ——
测试只测函数，不测接线。已补 `tests/feishu-message-budget.test.ts` 第六组，
直接读源码钉死调用点，反向注入可复现：

```
FAIL done 分支真的调用 clipForFeishu -- 没找到调用点，长文会原样全发
```

同类盲区值得警惕：**"函数对"和"被调用"是两件事**，本次两个 bug
（`resolveExecution` 未接线、`clipForFeishu` 可被绕过）都属于这一类。
