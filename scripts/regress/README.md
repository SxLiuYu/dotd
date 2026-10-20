# scripts/regress —— soak.sh 判据回归

这套东西验的不是 dotd 的功能，而是 **`scripts/soak.sh` 的判据本身会不会说谎**。
195 个用例，每个都拿一份人造数据喂 `soak.sh report`，断言它给出的退出码和结论对不对。

## 为什么它曾经不在仓库里

第 64-100 轮我一直把它放在 `/tmp`（后来挪到 Windows 临时目录），
理由是"这是我自己调试用的"。这是个错误判断：
**195 个用例、1100 多行，是这套判据唯一的防回归手段，它本身就是交付物的一部分。**
换台机器就没了，等于把「判据可信」这个结论建立在一份会消失的文件上。

## 三个文件

| 文件 | 作用 |
|---|---|
| `soak-criteria.sh` | 195 个用例。每个用例 = 一份夹具 + 一个期望退出码 + 一句 grep 断言 |
| `refresh-fixtures.mjs` | **夹具会过期**（`soak.sh` 的 `STALE_LIMIT=5400`）。这个把所有 `.jsonl` 的 `ts`/`proc_start` 平移到"现在-5 分钟" |
| `rebuild-heal-logs.mjs` | 平移后 `.wd` 里的自愈时间戳就对不上了。这个按新的段起点重建自愈日志 |

## 怎么跑

```bash
bash scripts/regress/soak-criteria.sh
# 夹具在别处（比如从快照恢复的目录）：
DOTD_FIXTURES=/path/to/fixtures bash scripts/regress/soak-criteria.sh
```

夹具默认在 `/tmp`。第一次在新机器上跑之前，**必须先有夹具**，见下节。

## 夹具从哪来

夹具是 195 个用例各自要的"人造 7 天数据"，格式见 `docs/acceptance/S6-guardrails.md`。
它们没有一份统一的生成器 —— 历史上是一个用例加一个、逐个 `node -e` 现写的。
搬运时我把"已有的 239 个夹具文件"原样带了过来，但**没有带生成脚本**（它们散在 `/tmp` 里 200 多个 ad-hoc `.mjs`）。

所以现在有两种用法：

1. **有夹具**（当前机器）：直接跑，跑前先 `refresh-fixtures.mjs` 再 `rebuild-heal-logs.mjs`。
2. **没有夹具**（新机器）：`soak-criteria.sh` 会大量 FAIL —— 不是判据坏了，是数据不在。
   需要按 `docs/acceptance/S6-guardrails.md` 的格式重建，或把 `$FIX` 指向一份快照。

**这是一个已知缺口，记在 `docs/backlog.md`。** 彻底的解法是给每类夹具写一个生成函数，
统一从"7 天/28 探针/1 段"这几个参数派生 —— 但这属于重写，不是这轮该做的。

## 夹具过期是最常见的假红

跑完看到一堆 `exit=1 期望=0`，**先怀疑夹具老了，不要先怀疑判据坏了**。
标准修复顺序：

```bash
node scripts/regress/refresh-fixtures.mjs
node scripts/regress/rebuild-heal-logs.mjs
bash scripts/regress/soak-criteria.sh
```

还有几类刷新脚本管不到的，要手工修（历史上踩过 5 次）：

- `day0*.txt` 里的 epoch 要跟着首点走
- `oneboot-boot.log` 必须写 **CST 本地时间**且文本含 **「daemon 就绪」**
  （`parseLog` 按本地时间解析；`healedDaemon` 只认「已恢复」或「就绪」）
- `.wd` 和 `.jsonl` 的 `proc_start` 必须**同时**平移
- 空 `.wd` 要重建，否则段的归因对不上
- 物理上不可能的组合（新 `proc_start` 配旧 `pid`）会被判成重启

## 两个反复踩到的坑

1. **`node -e '...' 里面不能写 `$FIX`** —— 单引号不展开，node 收到字面量。
   用环境变量传进去（`S2B_BAK="$bak" node -e '...'`）。踩过两次。
2. **`node -e '...' 2>&1` 会让 `exit $?` 拿不到 node 的退出码** ——
   文案全对、退出码全 0。只检查输出文字发现不了。

## 加用例时

- 用 `t <夹具> <wd日志> <名字> <期望退出码>` 这个 helper
- **断言要能失败**：如果一个 grep 写错就永远命中，它只是在安慰你
- 别把会漂的数字写死（比如 `采样密度 375%` —— 夹具一刷新就变成 367%）
