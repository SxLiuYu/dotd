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
- **判据**：(a) 造出的工具能跑；(b) 同类任务主动复用而非 shell.run 重写；(c) 三工具六环齐
- **实测**：
  - ✅ (a) `tool.create` 端到端跑通：造出 `word-count`（manifest + run.py 755），能执行出正确 JSON
  - ✅ (c) 三工具六环齐（容器实现/能力目录/白名单/治理/说明书）
  - ✅ (b) **已达成（2026-10-19，端到端真链路）**：`scripts/s2-reuse.sh` 跑通 ——
    模型发 `word-count` → 被翻译成 `tool.invoke` → succeeded，工具数仍为 1（没重复造）
  - ✅ (b) **跨模型复验**：deepseek-v4.1-flash / glm-5.3-flash / agnes-3.0-flash
    三个厂商 **全部 PASS**（都只调 tool.invoke、无 shell.run）。这三个模型此前全部失败
- **关键根因与解法**（前一会话定位、本会话落地）：
  提示词试满 3 次全败；根因不是模型不听话，而是"自造工具只是注入文本里的数据"，
  模型要做"看到文字→想到 tool.invoke(name)"的间接映射，对三个厂商都超纲。
  正解是把自造工具**动态注册成独立 tool**（名字即工具名、带自己的 args_schema）。
  但只做暴露不做路由会更糟（模型照着调必然被 `unknown_tool`/`工具未登记` 拒），
  故补齐执行路由：派发口翻译成 `tool.invoke(name=<它>, args=<模型参数>)`。
- **结论**：✅ 通过（S2 三条判据全部达成）
