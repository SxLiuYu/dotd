# 用 argo 替换 dotd 的联网搜索（2026-10-22）

## 1. 为什么必须换

实测本机（WSL）出口能力（`docs/net-reachability-20261022.md`）：

| 目标 | 直连 | 走 7890 代理 |
|---|---|---|
| baidu / github / zhihu | 200/302 | 200/302 |
| bing | 302 | 200 |
| duckduckgo | **000** | 200 |
| jd / smzdm | **000** | **000** |
| taobao / tmall / amazon | **000** | — |
| news.ycombinator.com | **000** | — |

结论：模型查"某物多少钱"必须落到 jd/tmall 这类电商站，而**这条路直连和代理都不通**。
不是工具写错了，是通路本身不存在。模型的降级链（net.get → web.read → web.snapshot）
在这类查询上必然全废——实测一次任务里 `net.get` 失败 8 次、`web.read` 失败 5 次。

argo 走自己的 272 个源（`anysearch` 引擎），**不经过本机出口**，因此不受上表限制。

## 2. 怎么接的

照着已有的 `web.*` 宿主侧工具三处注册模式（2026-10-21 建的那套）：

| 位置 | 改动 |
|---|---|
| `src/exec/searchtools.ts` | **新增**。`searchWeb()` / `searchFetch()`，spawn argo CLI |
| `src/exec/protocol.ts` | 声明 `search.web` / `search.fetch`（`sideEffect: 'safe'`，120s deadline） |
| `src/daemon.ts` | `exec.registerHostTool()` 两处 + `searchWrap` 错误包装 |
| `src/exec/ExecService.ts:263` | `HOST_SIDE_TOOLS` 加两个名字 |
| `config/tools.yml` | 两个都 `tier: read`（不弹审批） |

**为什么不用 `mcp.call`**：`mcp.call` 是 dangerous 档，**每次调用都要审批**，
日常查个价格要先点一次卡片，等于不可用。宿主侧工具是免审批路径。

**安全性**：`execFile(PY, [BIN, ...argv])` 数组传参，模型只能影响参数值，
不能影响可执行文件与子命令名（只允许 `search` / `fetch` 两个固定子命令）。

## 3. 部署位置

argo 已从 `C:\Users\1\.dsh\profiles\web\node_modules\argo-search`（13M）
**复制到 `/root/argo`**，避免跨 `/mnt/c` 文件系统调用（慢且依赖 Windows 挂载）。

```bash
export DOTD_ARGO_BIN=/root/argo/bin/argo   # 已写进 /root/wsl-daemon.sh
```

代码默认值也是这个路径（`searchtools.ts:21`），环境变量只是便于换机。

## 4. 验证证据

单测探针（`python3 /root/argo/bin/argo search`）：
```
共 5 条，显示前 3 条：
1. Score the Logitech MX Master 3S mouse for less...  $79.99
2. camelcamelcamel  $119.99 / $141.41
3. bestbuy  $79.99 - $121.07
```

真实任务 `tk_mvj8q7lgs3qyia`（"查罗技 MX Master 3S 多少钱"）：
- `search.web` 成功 4 次 / 失败 2 次（失败是模型传了超长 query，argo 侧超时）
- **拿到了 jd / tmall / zol 的真实报价**：348 元（京东自营+国补）、449 元、
  493 元（京东秒杀）、328.5 元（中关村在线，京东活动价）
- 对比：同一任务里 `net.get` 失败 8 次、`web.read` 失败 5 次，**全是电商站**

## 5. 已知限制

1. **argo 偶发超时**：query 过长或引擎慢时会失败，`retryable: true`，模型会重试。
2. **`search.fetch` 抓不动 JS 重站**：返回 `"error":"empty response"`。
   这类页面仍应走 `web.read`（真浏览器）。
3. **DSML 裸标签**：模型（deepseek-v4.1-flash）极少数轮次会把工具调用渲染成
   `<｜｜DSML｜｜ invoke ...>` 文本而非结构化 `tool_calls`。dotd 不做文本解析，
   于是那一轮等于空转。实测一个 24 轮任务里出现 1 次（4%）。
   **这是模型/网关侧行为，不是本期改动引入的**，但要留意——它会让任务
   "跑完了却没给主人答案"。
