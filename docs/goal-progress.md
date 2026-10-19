# goal-progress —— 六步执行记录

> 每步只记三行：判据 / 实测值 / 结论。

## S1 修绿基线
- **判据**：`npm test` 0 失败；`git status` 干净
- **实测**：D: 侧 1572/1572 通过、`tsc --noEmit` 0 错、`git status` 干净；
  WSL 侧 1565 过 / 1 skip / 0 挂（`temp-cleanup` 那条断言的是 Windows 句柄语义，
  Linux 允许删已打开目录，已按平台 skip，Windows 仍覆盖）
- **结论**：✅ 通过 —— 但 2026-10-19 复核发现先前"宣称完成"是假的：
  a16b001 标题写"yaml@2 替换 233 行手写解析器"，该改动根本不在提交里，
  只活在从未纳入 git 的 WSL 副本中。已由 137cc0b 把 WSL 在制品一次性拉回，
  两侧 7 个文件 md5 一致；`matchToolForGoal` 补 export；两处系统内部清单查询
  （`inventory_*` / `dynspec_*`）在测试里一并排除。

## S2 自己造工具
- **判据**：3 个任务各沉淀 ≥1 工具；第 4 次同类任务直接复用；三工具六环全绿
- **实测（进行中）**：
  - ✅ `tool.create` 端到端跑通：造出 `word-count`（manifest + run.py 755）
  - ✅ 生成的工具真能执行：`python3 run.py '{"text":"..."}'` 输出正确 JSON
  - ✅ 三工具六环齐（容器实现/目录/白名单/治理/说明书）
  - ✅ 安全：`tool.create` dangerous 档，实测触发审批
  - ✅ 清单注入：`toolInventoryNote` 已进 buildMessages（诊断确认 len=130）
  - ❌ **未达标**：模型看到清单但不用，仍倾向 `shell.run` 手写
  - ⏳ 未验证：3 个任务沉淀 + 第 4 次复用
- **结论**：⏳ 部分完成 —— 机制通了，模型行为没跟上
