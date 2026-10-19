# Backlog —— 判据外问题登记

> 规则（见目标）：每一步只做判据内的事；发现判据外的问题**记在这里，不当场修**。
> 避免在细节里打转。

| 日期 | 来源 | 问题 | 影响 | 建议 |
|---|---|---|---|---|

| 2026-10-19 | S1 基线 | `tests/temp-cleanup.test.ts` 在 Linux(WSL) 下失败：断言"连接未关的目录应删不掉"，但 Linux 允许删除已打开目录 | 仅 WSL 环境跑测试时红，Windows 全绿；生产跑在 WSL 但该测试不参与运行 | 改为按平台跳过断言，或换成真正的"删不掉"场景（如只读挂载点） |

| 2026-10-19 | S2 | 工具清单注入：`exec.runTool('tool.list')` 在容器内 ToolStore 能列出 word-count（直接 node 跑返回 1 项），但经 daemon 链路拿到空。日志只打出"发现 0 个"，说明工具调用成功了但结果结构不匹配，或调用根本没发生 | 模型感知不到已造工具，S2"可复用"判据未达标 | 待查：① 加原始返回结构日志定位；② 或改走 memory 桥（需给 MemoryServiceApi 加 listHomeDir/readHomeFile） |

| 2026-10-19 | S2 | 工具清单已注入上下文（诊断确认 len=130），但模型回答"我上下文里没有工具清单"且仍用 shell.run 手写 | 复用行为未达成；模型对注入的 system 段不敏感 | 可尝试：① 把清单并入运行手册末尾（模型对首条 system 更敏感）；② 或改成 user 消息；③ 或明确要求 tasks 里带"先查工具有没有现成的" |

| 2026-10-19 | S2(b) | **根因定位**：模型可见的 tools 是 `[..., tool.invoke]`（一个泛用工具），而自造工具 `word-count` 只是注入文本里的**数据**。模型必须自己完成"看到文字 → 想到要用 tool.invoke(name=word-count)"这一步间接映射。实测 3 个模型（deepseek/glm/agnes）全部失败 | S2(b) 无法通过提示词达成 | **正确解法**：把自造工具**动态注册成独立工具**（名字直接是 word-count，有独立 args_schema），模型就能像调 fs.read 一样直接选它。这是架构级改动，需改 toolSpecs() 动态生成 |
| 2026-10-19 | S1 复核 | **两份代码树分叉**：`/root/dotd`（WSL，daemon 实际运行）不是 git 仓库，其 yaml@2 迁移、`dynamicToolSpecs()`、TOOL-REUSE-GUARD 等改动从未提交；commit a16b001 的标题声称做了 yaml@2，但该提交里没有这个改动 | 每次同步都在丢改动；D: 侧 typecheck 直接失败（`dot.ts` 没 export `matchToolForGoal`，而引用它的测试已提交） | ✅ 已修（137cc0b）：WSL 在制品全部拉回 git，`npm i` 补 yaml，补 export，两侧 7 文件 md5 一致。**后续改动必须落在 D: 再同步到 WSL** |

| 2026-10-19 | S2(b) 阻塞 | 动态注册只做了"暴露"、没做"执行路由"：模型照着新清单直接调 `word-count`，会先在 `src/exec/protocol.ts:427 validateToolCall → findCapability()` 被判 `unknown_tool`，再过 `src/governance/gate.ts:326 lookupTool()` 被判"工具未登记"（config/tools.yml 没有它） | 该改动当前会让行为**比改之前更糟**（模型被引导去调一个必然被拒的工具）；S2(b) 因此过不了 | ✅ 已修（81e773d + 后续）：未走交接建议的 4 处改法，改为在 dot.ts 派发口做一次翻译（动态工具名 → tool.invoke(name,args)）。理由：工具/治理/journal/审批恢复全部照原路走，且动态工具自动继承 tool.invoke 的 dangerous 档审批，不新增绕过治理的路径；若改成"登记进白名单"，等于让模型自己写的脚本直接越过审批。端到端三个厂商模型全 PASS |
| 2026-10-19 | S3 验收 | ✅ 已修（见下条）· 原记录：**重复守卫对"全文重写类"追加无效**：`edit_file`（"再追加一行"）实测有 1 次模型把同一行追加了 22 次、43 次工具调用 / 82 秒。根因：`checkRepeat` 按「同工具 + 同参数签名」判重，而每次 `fs.write` 是把整个文件内容重写一遍、内容越来越长 → `repeatSignature` 永不相等 → 守卫不介入。`sameResultCount` 也救不了（`size_bytes`/`written_at` 每次都变） | 单个场景偶发 80s+ 与大量无效工具调用；不影响正确性（最终内容对），但费时费钱 | 建议：给重复守卫加一条"同工具 + 同 path + 参数单调增长（内容包含上次内容）"的判据；或对 `fs.write` 引入"写后校验意图"机制 |
| 2026-10-19 | S3 验收 | **（已修复）重复守卫对"全文重写类"追加无效** —— 见下方"修复记录"。复现：`bash scripts/acceptance.sh edit_file`（前置 3 行、要求追加 1 行），旧版本约 50% 概率把同一行追加十几~二十几次、耗时 80~115s、数十次工具调用 | 偶发极慢 + 大量无效调用；S3 复跑实测掉到 19/20 压线 | ✅ 已修：`SAME_PATH_REWRITE_LIMIT` + `checkSamePathRewrite()`。判据换成"同路径 + 新内容以旧内容为前缀（即整篇重写式追加）"，因为原三道护栏都依赖"参数或结果不变"，而这类打转恰恰每次都在变。修后连跑 3 次均 4 行/delta=1，整轮 S3 回到 20/20 |
| 2026-10-19 | S6 审计 | **`Runner.sealed`（封写去重键）只增不减**：`seal()` 里 `this.sealed.add(key)` 登记后永不删除（`resetRepeatGuard` 清了 repeatGuard/repeatSkipsByTask/toolCallCounts/rewritesByPath，唯独漏了 sealed） | daemon 长期运行时按"完成的任务数"单调增长 | 已量化**不构成 S6 判据威胁**：单条 key 约 88B，1 万任务 ≈ 0.84MB、10 万任务 ≈ 8.4MB；7 天窗口内不可能到 50MB。故本轮**不修**（避免碰核心收口逻辑），记此备查；若将来单机任务量级到十万级/天，需加 taskId 维度的清理 |
| `soak.sh` 的线程增长只打印不判定 | S6 判据只有四条（连续 7 天无人工干预 / RSS 增幅 <50MB / 成功率不掉 / 无句柄泄漏），**线程数不在其中**。实测线程 11→31（每 2h 涨 5，96 次重启）时报告照常 exit 0。按执行规则"判据外发现记 backlog、不当场修"，这里不扩大判据范围；但已把打印行标成"仅供参考，不参与判定"，避免读者误以为检查过了。若将来要纳入，做法与 RSS/句柄一致：取各生命周期内线程增长率中位数。 | 待定 |
