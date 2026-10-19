# S5 故障自恢复验收报告

> 判据：3 种故障 → **3/3 在 5 分钟内无人干预自愈**。
> 执行：`bash scripts/recovery.sh`　时间：2026-10-19
> 环境：WSL + `dotd-watchdog.sh` 由 **cron 每 2 分钟**触发（`*/2 * * * *`）

## 结论

**3/3 = 100%，均在 300s 内，全程无人工干预。**

| # | 故障 | 怎么造的 | 恢复耗时 | 恢复判据（不只是端口通） |
|---|------|----------|----------|--------------------------|
| 1 | 容器停掉 | `docker stop dotd-dot-dot1` | **53s** | 容器重新 `Up` **且** `docker exec` 能执行命令 |
| 2 | 网关端口不可用 | 从 Windows 侧 `Stop-Process` 杀掉 win-relay | **55s** | 13065 可连 **且** 端到端提交一句任务能 `done` |
| 3 | daemon 被 kill -9 | `kill -9 <daemon pid>` | **115s** | 7788 可达 **且** 能真接活并答完 |

## 关键设计：让"自愈"经得起推敲

1. **验收脚本绝不修故障**。它只 `docker stop` / `Stop-Process` / `kill -9`，然后干等。
   如果脚本顺手修了，测的就是脚本而不是系统。
2. **不认"端口通"**。容器 `Up` 不等于能干活，端口 `200` 不等于模型可用。
   所以每条都补一次**真实业务动作**（容器内执行命令 / 提交任务等它 `done`）。
3. **恢复必须来自无人值守路径**。日志时间戳对齐 cron 的整分钟（`:01`/`:02`），
   而不是我这轮手动跑的——否则不算"自恢复"。

## 修掉的三个真实缺陷（原本这步是过不去的）

这步一开始跑不通，不是判据太严，是系统真的不会自愈：

1. **watchdog 根本没装进 cron**。脚本早就写好、也拷到了
   `/usr/local/bin/dotd-watchdog.sh`，但 `crontab -l` 里没有它 → 从来不会被执行。
   现象：容器 `docker stop` 之后 5 分钟仍是 `Exited`。
   已安装为 `*/2 * * * *`。

2. **watchdog 只会"检测"容器，没有"修复"容器的代码**。
   实测日志连续打 `container 失败（第 1 次）` `（第 2 次）`，却始终没动手——
   因为它只有 `repair_daemon` / `repair_docker` / `repair_relay`。
   已补 `repair_container`（先 `docker start`，失败再退到 fleet 重建），
   并在检测失败时立即调用（容器是执行环境，没了就是全瘫，不该等告警阈值）。
   补完后：容器 **2s** 内恢复。

3. **cron 环境下 `powershell.exe` 找不到 → relay 永远修不好**。
   这是最隐蔽的一个：手工跑 watchdog 能修 relay，但 cron 跑就只会打
   `自愈:没有 powershell.exe,无法重启 Windows 侧 relay`。
   根因是 cron 的 `PATH` 极简，不含 `/mnt/c/...` 互操作路径，
   于是脚本里那句 `command -v powershell.exe` 直接放弃。
   现象：relay 杀掉后报警 3 次、300s 内一直 DOWN。
   已在脚本开头显式把 WSL 互操作路径补进 `PATH`。
   修完后：用 `env -i HOME=/root PATH=/usr/bin:/bin`（模拟 cron）跑，relay **2s** 恢复。

## 复现

```bash
cd /root/dotd
bash scripts/recovery.sh                 # 三种故障全跑（约 4 分钟）
bash scripts/recovery.sh container_stop  # 只跑一种
```

结果写入 `docs/acceptance/recovery.jsonl`。