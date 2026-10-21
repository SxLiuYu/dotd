# dotd 交接文档

> 写于 2026-10-21。给接手的人（或未来的自己）：读完这份就能知道**现在是什么状态、
> 哪些东西别信、下一步该干什么**。
>
> 不是功能清单（那些看 [ACCEPTANCE.md](ACCEPTANCE.md) / [muse-features.md](muse-features.md)），
> 是**交接**：现场、坑、未完的事。

---

## 1. 一句话现状

dotd 已经和 Meta Muse 对齐到可用状态：38 个工具、六步验收 + T1→T6 全过、
全量回归 **1606 通过 / 0 失败**。最近在收两件事的尾：把浏览器从容器搬到宿主
（已完成并上线）、把容器基座从 3.5GB 的 playwright 镜像换成 300MB 的 node slim
（**代码写完了，还没上线**）。

---

## 2. 代码在哪（两棵树，别搞混）

| 位置 | 是什么 | 有 git 吗 |
|---|---|---|
| `D:\toagi\dotd` | **权威仓库**，改动都提交在这里 | 有，master |
| `/root/dotd`（WSL） | **运行时副本**，daemon 从这里跑 | **没有 .git** |

改动流：D: 改 → 复制到 WSL → 跑测试 → 回 D: 提交。

```powershell
# D: → 临时文件 → WSL（必须去 CRLF，否则 WSL 侧脚本/tsx 会怪错）
Copy-Item "D:\toagi\dotd\<file>" "C:\Users\1\AppData\Local\Temp\sX_<name>" -Force
```
```bash
cp -f /mnt/c/Users/1/AppData/Local/Temp/sX_<name> <dest>
sed -i "s/\r$//" <dest>
```

**双向会冲突**：WSL 侧改过的东西不会自动回 D:。跑完测试要确认这次改的都还在。

---

## 3. daemon 怎么起停

```bash
# 停
kill $(pgrep -f "src/daemon.ts" | head -1)
# 起（~4 秒就绪）
DOTD_MAX_RUNNING=1 setsid bash scripts/dotd-daemon-start.sh
# 看真日志（别信别的路径）
tail -f /tmp/dotd-wsl.log
```

- 端口 **:7788**，`curl -s localhost:7788/healthz` 返 200 即活
- 环境变量要先 source，**不要把值打印出来**：
  ```bash
  set -a; . /root/dotd/_tokens_src.env; set +a
  ```

### CLI（没有 `tasks` 命令，别猜）

```bash
node --import tsx src/surfaces/cli.ts ask "<话>"      # 发任务
node --import tsx src/surfaces/cli.ts task <id> [--verbose]   # 看任务
node --import tsx src/surfaces/cli.ts approve <id> [once|remember|reject]
node --import tsx src/surfaces/cli.ts approvals
node --import tsx src/surfaces/cli.ts container
```

---

## 4. 测试怎么跑

**别直接跑全量**（300 秒会超时），用分块脚本丢后台：

```bash
nohup bash scripts/regress/suite-chunked.sh 15 >/tmp/fullN.log 2>&1 &
grep -oE "pass=[0-9]+ fail=[0-9]+" /tmp/fullN.log | awk -F'[= ]' '{p+=$2; f+=$4} END {print "pass="p" fail="f}'
```

跑一次约 1 分半。**基线：1606 通过 / 0 失败**（9 块）。数字变了要能解释。

### 一个反复骗人的陷阱

内存水位线类的测试会读 `/proc/meminfo`，**并发跑会假失败**（`§6.3 未标定` 之类）。
看到块级 `rc=1` 不要当回归，用那个块的确切文件列表单独重跑：

```bash
node --import tsx --test $(cat <该块的文件列表>)
```

已经骗过我好几次，每次单独跑都是全过。

---

## 5. 最近做完的两件事（含为什么）

### 5.1 浏览器从容器搬到宿主 ✅ 已上线

**原来**：容器里跑 playwright，模型调 `browser.*`，容器执行。
**现在**：宿主装 `agent-browser`（vercel-labs，Rust CLI），容器那套**已删除**。

为什么要搬：容器那套只能猜 CSS 选择器，模型经常猜错；`agent-browser` 用
**引用**（`snapshot` 出 `- link "Learn more" [ref=e2]`，然后 `click @e2`），
比选择器稳得多。

删掉的东西（都进 git 了，要回滚看 tag `pre-remove-container-browser`）：
- `agent-runtime/browser.ts`（460 行）
- `server.ts` 里 `browserCall` / `browserAct` / `adaptContext` / `axSnapshot` /
  `requireBrowserFactory`
- 28 条专属测试

**两个工具名并存**：`web.*`（新，推荐）和 `browser.*`（老名字，模型还在用）。
两条走同一引擎，`ExecService.runToolInner` 里宿主工具**优先于**容器同名工具。

**一个血泪坑**：`browser.snapshot` 一开始总是返回空。原因是 `browser.open` 有 url
能推导 session，而 `browser.snapshot` 没有 url → 落到匿名 session → 打开的页面
不在里面。解法是 `lastIdentityByTask` 按 taskId 记住上一步的身份。改这块时
别把这个记忆逻辑删了。

### 5.2 容器基座换 slim ⚠️ 代码完成，**未上线**

`mcr.microsoft.com/playwright:v1.49.1-noble`（3.55GB）→ `node:24-slim`（**563MB**）。

已实测通过（`dotd/exec:slim-probe` 这个镜像还在，可以直接起一个看）：
- uid 1000/1001 正确，`/dot/home` 可写
- `git` / `python3` / `pdftotext` / `pdfinfo` 齐全（原来靠 playwright 基座白捡，slim 里得显式装）
- setuid 降权到 1001 正常（Node 原生 `spawn({uid})`，不依赖外部命令）
- 57 条容器单测全过

**为什么没上线**：换基座要重建镜像 + 重启容器，属于会停服务的操作，
想留给你决定时机。上线步骤见下面第 7 节。

---

## 6. 现在真实状态（别信记忆，信这节）

| 项目 | 状态 |
|---|---|
| HEAD | `8937390` |
| 工作区 | 干净 |
| `npx tsc --noEmit` | 0 错误 |
| 全量回归 | 1606 / 0（9 块） |
| slim 改造 | **已提交**（`8937390`），镜像已验证但**未切到现网** |
| 现网跑的镜像 | **还是旧的** `dotd/exec:1.49.1-0.1.0`（3.55GB） |
| 容器 | `dotd-dot-dot1`，id `dbd70605a4e6` |
| daemon | 在跑，HTTP 200 |
| 邮箱账号 | 1 个活跃（`yujinze000@163.com`），11 封缓存 |
| crontab | 5 条 |
| 暂停的任务 | `tk_mvf3rc3gxyradt`、`tk_mvgow7taoew2sg`、`tk_mvgp03asc3qtkv` |

### 数据备份

改数据（尤其删账号、删任务）之前先备份：

```bash
cp /root/.dotd/dotd.db /root/.dotd/backups/dotd-<用途>-$(date +%Y%m%d-%H%M%S).db
```

已有的备份在 `/root/.dotd/backups/`。

### 看数据库

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/root/.dotd/dotd.db");
console.log(db.prepare("select ...").all());
'
```

表：`events, crontabs, task_results, steps, event_decisions, breaker_state,
breaker_sample, breaker_event, router_state, pool_probe_result, recon_candidate,
model_call_log, gov_seq, approval, mail_accounts, mail_drafts, mail_messages`

`steps` 列：`task_id, seq, kind, status, call_id, tool_name, args_json,
result_json, side_effect, run_epoch, approval_id, started_at, finished_at`

---

## 7. 下一步该干什么

### 7.1 把 slim 镜像上线（最直接的一件事）

代码已在工作区，测试已过，就差重建+切换：

```bash
cd /root/dotd
kill $(pgrep -f "src/daemon.ts" | head -1)
set -a; . /root/dotd/_tokens_src.env; set +a
bash scripts/rebuild-image.sh          # 约 2-3 分钟
# 起来后验证：容器内不该有 playwright，大小应 ~563MB
docker images | grep dotd/exec
docker exec dotd-dot-dot1 sh -c 'command -v pdftotext git python3'
```

**验证清单**（重建后务必过一遍）：
- [ ] `docker images` 里新镜像约 563MB
- [ ] 容器以 uid 1000 跑：`docker exec dotd-dot-dot1 id`
- [ ] `shell.run` 能跑 `git --version`、`python3 -V`、`pdftotext -v`
- [ ] `browser.screenshot` 还能落盘（走的是 home 卷，跟基座无关，但要确认）
- [ ] 全量回归仍是 1606 / 0

**回滚**：旧镜像 `dotd/exec:1.49.1-0.1.0` 先别删（`scripts/rebuild-image.sh`
开头会 `docker rmi` 它，注意别手快），D: 侧 `git revert` 那批改动即可。

### 7.2 一个收尾没做的：`pwVersion` 语义变了但没改名

`src/exec/types.ts:189` 里 `pwVersion: '1.49.1'` 现在**不再指 playwright 版本**
（已经没有 playwright 了），它现在唯一的作用是拼镜像 tag
（`dotd/exec:{pwVersion}-{runtimeVer}`）和当作 build arg 传给 Dockerfile
（Dockerfile 已不读这个 ARG，传了会被忽略）。

也就是说：**下次构建出来的 tag 还是 `1.49.1-0.1.0`，会误导人**。

没改是因为它牵动配置结构、DB 列名（`image_builds.pw_version`）和几处测试，
属于"改了没风险但容易改漏"的那种。想收拾的话建议改名 `baseImageTag`
并顺手把 DB 列也改了。

### 7.3 其它待办

见 [backlog.md](backlog.md)，其中比较值得做的（都已现场核实过）：

- **`scripts/soak.sh` 的注释和线上 crontab 对不上**：脚本第 15-16 行注释写的是
  `0 */6 * * * soak.sh probe`，线上实际是 `15 */6 * * *`。注释还据此论证"sample
  在 :00/:30、probe 在 :00，每 6 小时必然撞一次"——**前提已经不成立**，那段
  推导要重写。（改的是注释，别顺手去改 crontab，那是故意错开的。）
- 容器隔离（quarantine）后没有自动恢复
- `FEISHU_OWNER_CHAT_ID` 看着被污染：长度 **71**，正常应该是 `oc_` + 32 位 = 35。
  已核实确实 71。（打印长度是安全的，别打印值。）

> 一条更正记录：我一度以为 `: > "$RESULTS"` 截断写是个待修 bug，实际它在
> `scripts/acceptance.sh:103`，而且那段上下有 20 行注释专门解释**为什么必须**
> 先清空再跑（不清空的话上一轮证据会污染这一轮的判定，k1 全过却 exit=1）。
> 不是 bug。真正待确认的是"跑一半断电会留半截文件"这个边角，优先级很低。

---

## 8. 别踩的坑（都是真踩过的）

### 改文件

- **D: 的 TS 是 LF，别写成 CRLF**：`io.open(p,'w',encoding='utf-8',newline='\n')`
- **缩进别猜**。我多次从 WSL 侧 `sed` 输出推断缩进，结果 `assert` 反复失败。
  正确做法是先在 **D: 文件上**用 `repr()` 打出真实字节再写补丁：
  ```python
  s = io.open(r'D:\toagi\dotd\src\x.ts', encoding='utf-8').read()
  i = s.find('定位锚点')
  print(repr(s[i-60:i+300]))
  ```
- **`python -c` 里带中文引号会 `SyntaxError`**。写成 `.py` 文件再跑，
  且用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding $false)` 写。
- **PowerShell 会吃掉 `git commit -m` 里的中文多行**。把消息写进文件，
  用 `git commit -F <file>`，文件用 `io.open(..., newline='\n')` 写。

### 代码结构

- **加一个宿主编排工具要动五处**，少一处工具就不出现或词表测试红：
  1. `CAPABILITY_CATALOG`（`src/exec/protocol.ts`）—— 模型能不能看见
  2. `HOST_SIDE_TOOLS`（`src/exec/ExecService.ts`）—— 声明它不走容器
  3. `ToolDoc` + **`TOOLS_GUIDE`**（`src/runner/tool-catalog.ts`）—— 说明书
  4. `config/tools.yml` —— 开关
  5. `registerHostTool`（`src/daemon.ts`）—— 真的把实现接上

  **注意一个例外（2026-10-21 现场确认）**：`browser.*` 五个**不在**
  `HOST_SIDE_TOOLS` 里。它们在 `daemon.ts` 用一个循环注册进 `hostTools` Map，
  而 `ExecService.runToolInner` 是**先查这个 Map、再走容器**——所以照样覆盖成功。
  两条路都有效，但别以为 `HOST_SIDE_TOOLS` 是唯一开关；改 `browser.*` 时
  去 `daemon.ts` 找那个 `for (const name of [...])` 循环。
- `TOOLS_GUIDE` 里**必须写全名**（`browser.snapshot`），缩写（`snapshot`）不算，
  有测试逐字比对。
- `system-prompt.ts` 有**字符预算**（现在 `SYSTEM_PROMPT_BUDGET = 4700`）。
  加工具说明很容易超，超了会红。预算调高比删工具名好，但要在注释里写清理由。
- `browser.*` 五个名字**必须留在两份能力目录里**，即使容器已经没有实现了
  —— 模型按老名字调，治理/进度/截图推送也认这些字符串。

### 运行

- 别在 daemon 重启的同时跑回归（会互相干扰）
- 宿主截图落盘靠 `docker inspect` 解析卷路径，**别硬编码 `/var/lib/docker`**
- 删邮箱账号是**软删**（`status='disabled'`），不是物理删；而且
  `removeAccount` 按 label 匹配，两个账号 label 相同时要**按 id 删**

---

## 9. 关键路径速查

| 要改什么 | 去哪 |
|---|---|
| 工具定义/可见性 | `src/exec/protocol.ts`、`src/runner/tool-catalog.ts` |
| 宿主工具实现 | `src/exec/webtools.ts`、`src/daemon.ts` |
| 容器内执行 | `agent-runtime/server.ts` |
| 模型提示词 | `src/runner/system-prompt.ts` |
| 截图推送 | `src/surfaces/screenshot-push.ts` |
| 飞书出口 | `src/surfaces/feishu-outbound.ts` |
| 容器镜像 | `exec-image/Dockerfile`、`scripts/rebuild-image.sh` |
| 邮箱 | `src/mail/MailService.ts` |
| 数据库 | `/root/.dotd/dotd.db` |

### 容器关键事实

- 名字 `dotd-dot-<id>`（一般是 `dotd-dot-dot1`）
- **rootfs 只读**，只有 `/opt/agent-state/` 可写
- `/dot/home` 是 docker volume（挂到宿主是普通目录，可读写）
  —— 截图落盘就是靠这个
- 镜像 `dist` 是**烤进镜像**的，改 `agent-runtime/` 必须重建镜像

---

## 10. 验收相关

```bash
bash scripts/verify-goal.sh        # 只读，退出码即结论
bash scripts/regress/web-tools-criteria.sh    # 浏览器判据 18 条
bash scripts/regress/mail-criteria.sh
bash scripts/regress/calendar-criteria.sh
```

六步验收结论在 [ACCEPTANCE.md](ACCEPTANCE.md)，Muse 对齐细节在
[muse-tasks.md](muse-tasks.md)。

---

## 11. 最后

这份文档会过期。**当它和代码冲突时，信代码**，然后把这里改对。

现在最该更新的地方：第 6 节的状态表（尤其是 slim 上线之后）。
