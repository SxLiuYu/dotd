# S3 能力验收报告


> ⚠ **本文有时效性**（2026-10-20 第 106 轮补）。
> 文中数字是当时那一次运行的快照，**不是当前状态**。
> 当前状态一律以 `bash scripts/verify-goal.sh` 的输出为准（见 [ACCEPTANCE.md](ACCEPTANCE.md)）。
> 证据文件里的原始记录不会过期，本文的**摘要**会。
> 判据：20 条日常场景成功率 ≥ 95%（≥19/20）。执行：`bash scripts/acceptance.sh`
> 环境：真 daemon（WSL /root/dotd）+ 真模型（deepseek-v4.1-flash）+ 真容器（dotd-dot-dot1）
> 时间：2026-10-19

## 结论

**20/20 = 100%，达标。**

| # | 场景 | 类别 | 耗时 | 实际调用的工具 | 结果 |
|---|------|------|------|----------------|------|
| 1 | 350 减 405 = -55 | 算数 | 3s | （无，纯推理） | ✔ |
| 2 | 1280 打 7.5 折再减 100 = 860 | 算数 | 5s | （无） | ✔ |
| 3 | 鸡兔同笼（35 头 94 脚）→ 鸡 23 兔 12 | 推理 | 4s | （无） | ✔ |
| 4 | 读 q3-sales.txt 报三个产品销售额 | 读文件 | 6s | fs.read | ✔ |
| 5 | 列 notes 目录内容 | 读文件 | 7s | fs.list | ✔ |
| 6 | 写 reports/s3-write-test.txt 三行 | 写文件 | 8s | fs.write, fs.read | ✔ |
| 7 | 给该文件追加一行 S3-DELTA | 改文件 | 10s | fs.read, fs.write | ✔ |
| 8 | GET api.github.com/zen 原文 | 出网 | 8s | net.get | ✔ |
| 9 | 从 notes 里找 code-zebra-9 | 检索 | 12s | shell.run, fs.read | ✔ |
| 10 | 新建每天 9 点的提醒 | 定时 | 10s | schedule.list, schedule.create | ✔ |
| 11 | 列出当前所有提醒 | 定时 | 6s | schedule.list | ✔ |
| 12 | 描述 media/tri.png 的内容与配色 | 看图 | 5s | （无，多模态直读） | ✔ |
| 13 | 读发票 PDF 的票面信息 | 读 PDF | 11s | fs.stat, shell.run | ✔ |
| 14 | 读 report.pdf 报营收与增长率 | 读 PDF | 9s | fs.stat, shell.run | ✔ |
| 15 | 读 q3-sales.xlsx 报华东/华南收入 | 读 Excel | 37s | fs.list, fs.stat, shell.run | ✔ |
| 16 | 造 char-count 工具并自测 | 造工具 | 20s | tool.list, tool.create, tool.invoke | ✔ |
| 17 | 用已有工具数「今天天气不错。」字符数 | 复用工具 | 7s | tool.invoke | ✔ |
| 18 | 读文件并把三个产品求和 = 405 | 综合 | 7s | fs.read | ✔ |
| 19 | 一句话概括 MEMORY.md | 综合 | 8s | fs.read | ✔ |
| 20 | 自述能做/不能做什么 | 边界 | 7s | （无） | ✔ |

平均 9.5s，最慢 `excel_read` 37s。

## 判据怎么设计的（避免"假过"）

这一版刻意做过两轮加固，因为第一版有**判据造假**的地方：

1. **`vision_png` 原本是假过**。第一版判据查回答里有没有"三角"——因为文件名叫 `tri.png`。
   实际逐像素解码后确认：那张图是 60x20、三列各 20px 的**纯红/纯绿/纯蓝竖条，不是三角形**。
   模型回答"三个竖色块，不是三角形"是**对的**，反倒会被旧判据判错。
   已改成核验红/绿/蓝三色，并核对到像素级事实。
2. **`edit_file` 原本是假过**。前置脚本自己写了含 `S3-DELTA` 的文件，模型读到后
   正确地拒绝重复追加 → 判据（grep 到 DELTA）就过了。但那验的不是"追加"这个动作。
   已改成前置只写 3 行（不含 DELTA），并把判据收紧为"4 行且 DELTA 恰好 1 次"。
3. **`sched_create` 原本是假过**。库里本来就有旧的 `0 9 * * *`，grep 得到即过。
   已改成跑前清场 + 比对跑前跑后条数必须变多。
4. **`tool_create` 原本只查目录存在**。已改成实跑 `run.py` 断言 `abc中文 → chars=5`。
5. **`tool_reuse` 原本只查"调了 tool.invoke"**。已追加断言输出数字必须等于 7。

## 已知不稳定（记入 backlog，未在本步修）

`edit_file`（追加一行）在**前置文件真的缺那一行**时不稳定：60 次运行里有 1 次
模型把同一行追加了 22 次、烧掉 43 次工具调用 / 82 秒才收尾。根因是重复守卫
按「同工具 + 同参数」判重，而每次 `fs.write` 全文重写的内容都在变长，
签名永不相等 → 守卫不介入。已记 `docs/backlog.md`。

本报告这一轮 20/20 是**真跑出来的**（`edit_file` 该轮 10s、3 次调用、文件从 3 行变 4 行）。

## 复现

```bash
cd /root/dotd
bash scripts/acceptance.sh              # 全部 20 条
bash scripts/acceptance.sh calc edit_file   # 只跑指定 id（调试）
```

结果逐条写入 `docs/acceptance/results.jsonl`（含 pass/status/tools/answer 证据）。