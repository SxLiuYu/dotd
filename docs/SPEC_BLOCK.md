# SPEC_BLOCK.md —— 连接器第一批工具规范（task-2 交付附件）

> 交付：connector（task-2，连接器框架 + GitHub + RSS）。本文**只提供规范文本**；
> `CAPABILITY_CATALOG` / `HOST_SIDE_TOOLS` / `tool-catalog.ts` / `tools.yml` 的接线由 lead 统一做
> （task-2 写入边界 = 纯新文件，共享区不碰）。
>
> 实现已就位，接线即用：
> - `src/connectors/registry.ts` —— `connectorCatalog(env?)`：`github` 有 `DOTD_GITHUB_TOKEN` → `connected`，无 → `public-only`；`rss` 恒 `ready`。
> - `src/connectors/github.ts` —— `githubNotifications(opts)` / `githubIssues(owner, repo, opts)` / `githubPulls(owner, repo, opts)`。
> - `src/connectors/rss.ts` —— `fetchFeed(url, opts?)`。
>
## §1 建议的 CAPABILITY_CATALOG 追加块（与 protocol.ts 的 mail.list 逐字段同形）

5 条全部 `mode: 'sync'` / `max_deadline_ms: 60_000` / `sideEffect: 'safe'`：
内部网络超时统一 15s（github.ts / rss.ts 各自的 `*_TIMEOUT_MS`），天然落进 sync 60s 档；
5 条都是只读 GET，无一写操作，按契约 J2 判 `safe`。

```ts
{
  /** 宿主侧工具：列当前 GitHub 通知（mention / review_requested 等，需配 token）。 */
  name: 'github.notifications',
  mode: 'sync',
  max_deadline_ms: 60_000,
  args_schema: obj({}, []),
  sideEffect: 'safe',
},
{
  /** 宿主侧工具：列一个仓库的 open issues（按 updated 倒序，已剥离 PR 混入）。 */
  name: 'github.issues',
  mode: 'sync',
  max_deadline_ms: 60_000,
  args_schema: obj(
    {
      owner: str('仓库属主，如 "octo"'),
      repo: str('仓库名，如 "hello"'),
      page: { type: 'integer', minimum: 1, description: '页码，缺省 1（翻页看返回里的 nextPage）' },
      per_page: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，缺省 20' },
    },
    ['owner', 'repo'],
  ),
  sideEffect: 'safe',
},
{
  /** 宿主侧工具：列一个仓库的 open pull requests（按 updated 倒序）。 */
  name: 'github.pulls',
  mode: 'sync',
  max_deadline_ms: 60_000,
  args_schema: obj(
    {
      owner: str('仓库属主'),
      repo: str('仓库名'),
      page: { type: 'integer', minimum: 1, description: '页码，缺省 1' },
      per_page: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，缺省 20' },
    },
    ['owner', 'repo'],
  ),
  sideEffect: 'safe',
},
{
  /** 宿主侧工具：列出已配置的 RSS/Atom 订阅源（订阅清单存配置，见 §3 开放点）。 */
  name: 'rss.feeds',
  mode: 'sync',
  max_deadline_ms: 60_000,
  args_schema: obj({}, []),
  sideEffect: 'safe',
},
{
  /** 宿主侧工具：拉取并解析一个 RSS 2.0 / Atom 源，返回去重后的条目。 */
  name: 'rss.read',
  mode: 'sync',
  max_deadline_ms: 60_000,
  args_schema: obj(
    { url: str('订阅源 URL，http(s)，如 "https://example.com/feed.xml"') },
    ['url'],
  ),
  sideEffect: 'safe',
},
```
## §2 建议的 ToolDoc 文本（tool-catalog.ts 的 ToolDoc 形状）

### github.notifications

```ts
{
  name: 'github.notifications',
  description:
    '列出当前配置的 GitHub 账号的未读/最新通知：谁在哪个仓库 mention 了你、请求你 review 哪个 PR、' +
    'issue 有新评论。配了 DOTD_GITHUB_TOKEN 才可用（未配时连接器状态是 public-only，这个工具会直接报错）。' +
    '要查某个仓库的 issue / PR 清单用 github.issues / github.pulls，别用通知凑。',
  params: {},
  returns:
    'JSON 数组，每条含 id、reason（mention / review_requested / comment 等原词）、title、subjectType' +
    '（Issue / PullRequest / Release）、url（API url）、repo（owner/name）、updatedAt、unread。' +
    '另带 rateLeft（剩余 API 配额）。',
  failures:
    'no_token：没配 DOTD_GITHUB_TOKEN —— 提示主人去配，不要重试；' +
    'timeout / network：15s 超时或网络不通 —— 稍后重试；' +
    'http_401 / http_403：token 无效或配额耗尽（对照 rateLeft）—— 别原样重发。',
}
```

### github.issues / github.pulls

```ts
{
  name: 'github.issues',   // github.pulls 同形，把 issue 换成 PR
  description:
    '列一个仓库当前 open 的 issues，按最后更新时间倒序（GitHub 的 PR 会混进 issues 端点，已剥离）。' +
    '查公开仓库不需要 token；私有仓库需要。要知道每页还有没有下一页看返回里的 nextPage。',
  params: {
    owner: '仓库属主，如 octo/hello 里的 octo',
    repo: '仓库名，如 octo/hello 里的 hello',
    page: '页码，从 1 起；缺省 1',
    per_page: '每页条数，1-100，缺省 20',
  },
  returns:
    'JSON 数组，每条含 number、title、url（html url）、user（作者 login）、updatedAt、comments、' +
    'labels（标签名字符串数组）；github.pulls 每条另有 draft 布尔。另带 rateLeft / nextPage / prevPage。',
  failures:
    'http_404：仓库不存在或（私有仓库）没配 token —— 先核对 owner/repo 拼写；' +
    'http_403：未认证限速 60 请求/小时耗尽 —— 配 token 或稍后再试；' +
    'timeout / network / bad_json：网络层问题 —— 稍后重试。',
}
```

### rss.feeds / rss.read

```ts
{
  name: 'rss.feeds',
  description:
    '列出已配置的 RSS/Atom 订阅源（id、url、备注）。想知道某个源现在有什么新文章，' +
    '拿它的 url 调 rss.read；要加新的订阅源，先在配置里登记（这个工具是只读目录）。',
  params: {},
  returns: 'JSON 数组，每条含 id、url、desc（备注）。',
  failures: '配置里一个订阅源都没有时返回空数组 —— 提示主人先登记，不要猜 URL。',
}
{
  name: 'rss.read',
  description:
    '抓一个 RSS 2.0 或 Atom 源并解析成条目列表。url 必须是 feed 地址（不是文章页）；' +
    '不确定时先用 rss.feeds 看有没有登记过。返回按 link 去重，同一链接只出现一次。',
  params: {
    url: '订阅源 URL，http(s)，如 https://example.com/feed.xml',
  },
  returns:
    '{ title, items }：items 每条含 title、link、published（源里的原始时间串，RSS 是 RFC 822、' +
    'Atom 是 ISO 8601）、text（摘要纯文本，已去 HTML 标签、解实体）。',
  failures:
    'bad_xml：地址不是订阅源（多半是普通网页）—— 换真正的 feed 地址；' +
    'http_404 / http_403：源挂了或反爬 —— 换源或稍后再试；' +
    'timeout / network：15s 超时或网络不通 —— 稍后重试。',
}
```
## §3 接线注意（给 lead 的备忘，不是规范本体）

1. **HOST_SIDE_TOOLS**：5 个名字全部是宿主侧工具（不进容器），需要加进
   `src/exec/ExecService.ts` 的 `HOST_SIDE_TOOLS` 白名单，并在 daemon 里 `registerHostTool`：
   - `github.notifications` → `githubNotifications()`（无 token 时实现已直接返回结构化 `no_token`，处理器原样透传即可）
   - `github.issues` → `githubIssues(owner, repo, { page, perPage })`（注意 schema 的 `per_page` → opts 的 `perPage`）
   - `github.pulls` → `githubPulls(owner, repo, { page, perPage })`（同上）
   - `rss.feeds` → **见开放点 ②**
   - `rss.read` → `fetchFeed(url)`
2. **返回体约定**：成功形状统一 `{ ok: true, data, rateLeft?, nextPage?, prevPage? }`，
   失败 `{ ok: false, error }`（前缀即错误码：`no_token` / `timeout` / `network` / `http_NNN` / `bad_json` / `bad_shape`），
   **永不抛** —— 处理器把 `error` 透传给模型即可，不必包 try/catch。
3. **status 判定**：模型问"GitHub 配好了没"用 `connectorCatalog()`；不要在处理器里另写一套
   token 探测（`hasGithubToken()` 已导出，语义同 registry）。
4. **mode/sideEffect 判据**：5 条全 `sync` + `safe` 的理由见 §1 开头；内部 15s 超时 < 60s sync 档，
   实现侧不会触发 `deadline_too_long`。

### 开放点（需要 lead 拍板，connector 不越界替你决定）

- **① per_page vs limit**：github.issues/pulls 的分页参数我按 GitHub 原名写的是 `per_page`；
  若想和 mail.list 的 `limit` 统一口径，改 schema 字段名即可，处理器映射时改名。
- **② rss.feeds 的数据源**：task-2 的实现只有 `fetchFeed(url)`，**没有**订阅清单的存储。
  rss.feeds 要返回"已配置的订阅源"，需要配置里有个落点（建议 daemon 配置加
  `rss.feeds: [{ id, url, desc }]`，字段你定）。首版如果想先通，也可以让 rss.feeds 返回
  `connectorCatalog()` 的 rss 条目 + 空清单说明——但那只是占位。
- **③ rss.subscribe / rss.remove**：本期范围没有"添加/移除订阅"工具（涉及写配置 = 跨进
  lead 的单一写入区）。若第二批要加，建议与 ② 的配置落点一起设计。

—— 以上 3 点均不阻塞 §1/§2 的 5 条规范本身。

## 验收对照（task-2 第 5/6 条）

- 测试：`tests/connectors/github.test.ts`（13 个）+ `tests/connectors/rss.test.ts`（10 个），
  共 23 个 / 远超 ≥12 断言目标；fetch 全打桩、fixtures 离线，WSL `/root/dotd` 实跑全绿。
- 覆盖：正常解析（3 个 fixture）、分页 Link 头、rateLeft、超时 → 结构化错误、
  RSS 命名空间容错、Atom 与 RSS 2.0 各一 fixture、坏 JSON/坏形状/HTTP/网络错误折叠。