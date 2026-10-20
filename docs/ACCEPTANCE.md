# 验收说明 —— 这份交付到底做完了没有

**一句话结论：S1–S5 全部达标，目标已达成。**

（S6「7 天长期运行」已由用户于 2026-10-20 明确移出目标范围 —— 见文末。）

本文是给验收人看的入口。不想读 3600 行 `goal-progress.md`，就只看这一页。

---

## 怎么看

```bash
# 一条命令回答五步过没过（只读，不改任何数据）
bash scripts/verify-goal.sh

# ⚠ 在 WSL 侧跑（/root/dotd 不是 git 仓库）时，要告诉它权威仓库在哪：
DOTD_GIT_REPO=/mnt/d/toagi/dotd bash scripts/verify-goal.sh

# 带 --run 会真跑 S1/S3/S4/S5（会跑 npm test、发任务、kill 容器）
DOTD_GIT_REPO=/mnt/d/toagi/dotd bash scripts/verify-goal.sh --run
```

> 退出码：`0` = 五步全过（目标达成）；`1` = 有步骤不通过；`3` = 有步骤还没到判的时候；`2` = 脚本自身出错。
>
> **本机实测：`exit=0`，`合计：✅ 5   ❌ 0   ⏳ 0`。**

### S1 的 npm test 有个前提，得说清

`npm test` 必须跑在**拥有 `node_modules` 的那个平台**上。
这一份的 `node_modules` 是 Windows 装的（esbuild 是 native 二进制），
所以从 WSL 跨 `/mnt/d` 跑会得到 `pass 0 / fail 118`，全部报：

```
You installed esbuild for another platform ...
"@esbuild/win32-x64" is present but this platform needs "@esbuild/linux-x64"
```

**那个红是假红。** 在 Windows 侧跑同一个 `npm test` 是 1579 / 0。

所以 `verify-goal.sh` 的只读模式读 `docs/acceptance/s1-npmtest.json` 这份证据，
**并带 24h TTL**（`S1_EVIDENCE_TTL_H` 可调）——证据过期就退回 ⏳，
不会拿旧数据冒充现在的结论。要刷新：

```powershell
cd D:\toagi\dotd; npm test    # 然后把 pass/fail 写进 docs/acceptance/s1-npmtest.json
```

---

## 五步现状

| 步 | 判据（原文） | 实测 | 状态 |
|---|---|---|---|
| S1 | `npm test` 0 失败 + `git status` 干净 | 1579 pass / 0 fail；`git status` 干净 | ✅ |
| S2(a) | 能通过 `tool.create` 把脚本落盘成可复用工具，且能正确执行 | `tool.create` 15 次；容器里 `word-count` 已跑通 | ✅ |
| S2(b) | 同类任务主动用 `tool.invoke`，而非 `shell.run` 重写 | **4/4**（有 `tool.invoke`、无 `shell.run`、未新建工具、答案对） | ✅ |
| S2(c) | 三个工具六环齐全 | `config/tools.yml` 19 条白名单 | ✅ |
| S3 | 20 条日常场景成功率 ≥95% | **20/20 = 100%** | ✅ |
| S4 | 10 条做不到的任务，10/10 承认、0 编造 | **10/10** | ✅ |
| S5 | 3 种故障 3/3 自动恢复、<5 分钟 | **3/3**（容器 99s / 网关 5s / daemon 50s） | ✅ |
| ~~S6~~ | ~~连续 7 天无人工干预；RSS <50MB；成功率不掉；无句柄泄漏~~ | 用户 2026-10-20 指示「长期运行不用作为一个目标」 | **不在范围内** |

**五步判据全部通过。**

原先的 S6（连续 7 天长期运行）已移出目标范围，理由不是「达不到就改判据」，
而是**用户改了口径**：他要的是「能验收的成品」，7 天连续运行不在交付清单里。

观测设施 `scripts/soak.sh` 仍在跑、仍如实记录，`verify-goal.sh` 把它显示为
`▫️ 只报告不判定`，**不影响退出码**。想看它现在什么状态：`bash scripts/soak.sh report`。

---

## 判据各自的证据在哪

| 步 | 证据文件 | 怎么单独复验 |
|---|---|---|
| S1 | 无（跑测试本身） | `npm test`（在 `D:\toagi\dotd` 下跑，不要在 WSL 的 `/mnt/d` 跑） |
| S2 | `docs/acceptance/s2b-reuse.jsonl` | `bash scripts/s2b-verify.sh --judge` |
| S3 | `docs/acceptance/results.jsonl`（20 行） | `bash scripts/acceptance.sh --judge` |
| S4 | `docs/acceptance/honesty.jsonl`（10 行） | `bash scripts/honesty.sh --judge` |
| S5 | `docs/acceptance/recovery.jsonl`（3 行） | `bash scripts/recovery.sh --judge` |
| S6 | `docs/acceptance/soak.jsonl`（持续追加） | `bash scripts/soak.sh report` |

`--judge` 都是**只读**的：读现有证据重新判定，不发任务、不注入故障。
（例外：`s2b-verify.sh` 不带 `--judge` 会真发一个任务。）

---

## 长期运行观测（不在验收范围内）

窗口起点 `2026-10-20 06:43:55`，7 天后是 `2026-10-27 06:43:55`。

期间：
- 每 30 分钟一次 `sample`（cron `*/30`），记录 RSS / 句柄 / 容器 / 网关 / daemon 状态
- 每 6 小时一次 `probe`（cron `15 */6`），真的发一条消息给飞书、验证收发通
- 7 天共 336 个采样点、28 个探针

**判据不是"看起来稳"，而是**：
- 探针成功率 ≥95%（28 次最多错 1 次）
- RSS 峰值增长 <50MB（基线是最前 2 小时的中位，峰值取全窗口最高）
- 句柄峰值增长 <20
- 无「连续 2 次探针失败」、无「2 小时以上的断档」
- 每次重启都能在 watchdog 日志里找到自愈记录（否则算"人工干预"）

---

## ⚠ 观测窗口仍在计时，别做这三件事（会毁掉观测数据）

1. **不要跑 `verify-goal.sh --run`**
   它内含 `recovery.sh`，会真的 `docker stop` 容器、`kill -9` daemon ——
   那是窗口里的人为中断。脚本已经内置拒绝（`exit 2`），
   确要重来一次窗口才用 `DOTD_ALLOW_DISRUPT=1`。

2. **不要重启 daemon / 重启 WSL / `docker restart`**
   任何重启都会进 `restartRows`，然后要求有自愈记录佐证。

3. **不要裸跑 `soak.sh`**
   `soak.sh:2467` 是 `case "${1:-sample}"` —— **不带参数 = 执行 sample = 往观测数据里写一行**。
   详见 `docs/acceptance/NO-ARG-TRAP.md`。

---

## 如果 7 天后要看的是这些

```bash
bash scripts/soak.sh report
```

期望看到（全部绿才算过）：

```
判定：✅ 判据全程同一个版本（…）；✅ 已满 7 天且观测连续；✅ RSS 增长 <50MB；
✅ 探针覆盖 7/7 段；✅ 探针密度 ≥70%；✅ 窗口内可用率 100.00%；… 
```

`exit 0` 才算 S6 达标。

---

## 已知的产品级缺陷（不影响上面五步的判定）

都记在 `docs/backlog.md`，这里只列会被验收人问到的：

- **S2(b) 的答案校验靠 `grep -F`**：模型答「3,500,000」会判错，「1,350万」会判对。
  实测它答的是「350万」，命中。但这靠的是措辞，不是判据。
- **三个验收脚本都是「先清空再追加」**：中途打断会砍掉历史证据，
  而事后看起来像"本来就只有这些"。
- **`soak.sh` 的 `⚠ 用过 N 个判据版本` 不判红**（实测 `exit=0`）：
  窗口中途改过判据脚本，交付物会带这个 ⚠，但不算失败。

---

## 这份文档本身的可信度

它不是手写的承诺，是对着这六条命令的实际输出抄下来的。
每条都能用上面「怎么单独复验」那一列自己重跑一遍。

**唯一的例外是 S6 的剩余天数**：它每天都在变，所以本文不写具体值。
2026-10-20 第 106 轮写这份文档时逐条核对过：`tool.create` 15 次、白名单 19 条、
`results` 20 行、`honesty` 10 行、`recovery` 3 行 —— 全部与实测一致。
但**这些数字也会随运行变化**（比如 `tool.create` 会继续增加），
真正不会变的是「证据文件在哪」和「怎么复验」这两列。
