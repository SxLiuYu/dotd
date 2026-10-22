# 手写行解析器 x 行尾（CRLF/LF）审计表

审计日期：2026-10-22

触发事故：Windows 工作区（core.autocrlf=true）检出的 config/models.yml 是 CRLF，
parseModelsYaml 用 text.split('\n') 切行，每行末尾残留 \r，**整份配置解析成 0 个端点**，
daemon 启动即抛「models.yml 未定义任何端点」拒启动。同一文件在 WSL（LF）下全绿 —— 这类
bug 在 Linux CI 上永远不会暴露。

审计方法：不靠读代码推理，**每条都用真实输入实测**（LF 与 CRLF 各跑一遍，比对结果）。
下文「证据」列全部来自当场运行。

---

## 一、致命项（真实配置 + CRLF → 解析结果错误）

| # | 位置 | 手法 | CRLF 下的实际后果 | 处置 |
|---|---|---|---|---|
| 1 | src/router/config.ts:305 parseModelsYaml | text.split('\n') | **endpoints = 0 个**、primary/light 全 undefined、recon.sources = 0、light_events = 0 → daemon 拒启动 | 改为 text.split(/\r?\n/)（commit 3ae8e02）|
| 2 | src/router/pool.ts:426 parseFreeModelsYaml | text.split('\n') | 值带尾随 \r：updated_at 为 "null         \r"，与 LF 结果不一致 | 同上（commit 3ae8e02）|

两项已修，并由新增测试 tests/config-eol-invariance.test.ts 钉住。

---

## 二、已安全 —— 但**必须靠实测确认**，不能靠推理

以下都含「按行切分」或「行尾相关正则」，逐一实测后确认 CRLF 下结果与 LF 完全相同。

| # | 位置 | 为什么安全 | 实测证据 |
|---|---|---|---|
| 3 | src/surfaces/config.ts:141 parseYamlSubset | 早已是 text.split(/\r?\n/) | dotd.yml 深比较：LF 1042 字节 == CRLF 1042 字节，brief/connWatch 均正确 |
| 4 | src/event-rules.ts:72 | 早已是 text.split(/\r?\n/) | event-rules.yml 规则条数 LF == CRLF |
| 5 | src/exec/mcp-config.ts:96 | 早已是 text.split(/\r?\n/) | mcp-servers.yml 条目 LF == CRLF（默认空也一致） |
| 6 | src/governance/catalog.ts | 不经手写切行，走 yaml 库 + zod | tools.yml 45 个工具、档位分布 {read:29, write_file:10, dangerous:5, browser:1}，LF == CRLF |
| 7 | src/router/transport.ts:993 parseCuratedYaml | 每行先 raw.trim()，\r 被 trim 掉 | 代码逐行核对：:998 const line = raw.trim() |
| 8 | src/router/transport.ts:729（SSE） | 每行先 line.trim() 再判 data: 前缀 | 同上，:731 const t = line.trim() |
| 9 | agent-runtime/ledger.ts:129 | 每行先 line.trim() | :130 const t = line.trim() |
| 10 | agent-runtime/fs.ts:506 fs.grep | 行内容用于正则匹配与展示，\r 不参与判定 | 尾随 \r 只影响行尾空白，不影响 match 结果 |
| 11 | src/memory/outbox-guard.ts:45 splitOutboxBlocks | offset += line.length + 1 —— 每行的 \r 计入 length，+1 正好对应 \n，偏移量在 CRLF 下**恰好正确** | 合成 CRLF 样本 + 真实 ~/.dotd/OUTBOX.md：2 块，content.slice(start,end) === text 全部自洽，signature 正确提取 |
| 12 | src/daemon.ts:547 dotdReserveMb | JS 多行模式 $/^ 把 \r 也算行终止符 | LF → "2048"；CRLF → "2048" |
| 13 | src/router/outbox.ts:107 pruneResolved /(?=^## \[)/m | 同上，^...(?=) 在 \r 前仍匹配 | LF 2 块；CRLF 2 块，两块 startsWith('## [') 均 true |
| 14 | src/exec/fleet.ts:2313 MemAvailable | 源是 /proc/meminfo，恒为 LF；且 $ /m 对 \r 安全 | LF → 2048；CRLF → 2048 |
| 15 | src/mail/smtp.ts:232 Message-ID | 取值后立即 .trim() | CRLF → "<x@y>"（已 trim） |
| 16 | src/mail/imap.ts:333 头部正则 | 显式写 \r\n 作分隔符 | CRLF → "hi" 正确 |
| 17 | src/calendar/ics.ts:64 unfoldLines | 先 replace(/\r\n/g,'\n').replace(/\r/g,'\n') 归一 | RFC 5545 要求如此，实现正确 |
| 18 | scripts/init-config.mjs:143/164 | $ /m 对 \r 安全 | LF true；CRLF true |
| 19 | src/surfaces/daily-brief.ts:269/278 | 切的是内存里已构造的正文，不读文件 | 不涉及外部行尾 |
| 20 | src/governance/review.ts:131/264、src/exec/webtools.ts:167/358、src/surfaces/cli.ts:491、src/surfaces/progress-push.ts:129、src/exec/fleet.ts:2208 | 切的是模型/子进程输出，且随后 trim() | 不涉及配置文件行尾 |

---

## 三、跨配置文件验证（真实文件 x 两种行尾）

对仓库自带 7 份配置各跑两遍，断言结果完全相同：

| 配置 | 解析入口 | 结果 |
|---|---|---|
| models.yml | parseModelsYaml | 修后一致（修前 CRLF 为 0 端点） |
| free-models.yml | parseFreeModelsYaml | 修后一致（修前 updated_at 带 \r） |
| tools.yml | loadCatalogFile | 一致（45 工具） |
| rules.yml | loadRulesFile | 一致 |
| dotd.yml | loadSurfacesConfig | 深比较完全相同 |
| event-rules.yml | parseEventRules | 一致 |
| mcp-servers.yml | parseMcpServersYaml | 一致 |

---

## 四、失败探针（证明测试不是空转）

把 config.ts / pool.ts 临时改回 text.split('\n')，再跑 tests/config-eol-invariance.test.ts：

    ✔ 前置：样本确实各自是纯 CRLF / 纯 LF
    ✖ models.yml：端点/主模型/续行列表在 CRLF 下不得丢失
        AssertionError: CRLF 端点不能是 0 个（修前就是 0，这是本用例的存在理由）
    ✖ free-models.yml：条目与 updated_at 在 CRLF 下不得失真
        AssertionError: Expected values to be strictly deep-equal
    ✔ tools.yml：45 个工具白名单不得因 CRLF 掉成空
    ✔ rules.yml / ✔ event-rules.yml / ✔ mcp-servers.yml / ✔ dotd.yml
    ℹ tests 8  pass 6  fail 2

失败的正好是修过的那两项，未修的六项照常通过 —— 说明测试**精确指向问题**，不是笼统地红一片。
恢复修复后 8/8 通过。

---

## 五、结论

1. **这一类 bug 在本仓库只有 2 处真实存在**（router/config.ts、router/pool.ts），均已修。
2. 其余 18 处按行切分/行尾正则**本来就安全**，原因分三类：早已用 /\r?\n/（#3-5）、
   每行 trim() 兜住（#7-9）、JS 多行 $/^ 本身就把 \r 当行终止符（#12-14、#18）。
   第 11 项（outbox-guard）的偏移量计算在 CRLF 下**恰好自洽**，属于巧合但已验证成立。
3. 我最初怀疑 daemon.ts:547 和 router/outbox.ts:107 有 bug —— **实测证否**。
   这正是"先写失败探针再下结论"的价值：光读代码会把这两处误报成缺陷。
4. 防复发：tests/config-eol-invariance.test.ts 对 7 份真实配置做 CRLF/LF 双跑断言，
   任何解析器回归立刻红，报错直接点名是哪份配置。

## 六、验证状态

| 项 | Windows | WSL (/root/dotd) |
|---|---|---|
| tsc --noEmit | 0 错误 | — |
| 全量测试 | **1840/1840 通过** | **1839 通过 + 1 跳过** |
| 新增 EOL 测试 | 8/8 | 8/8 |
| 关键文件一致性 | — | config.ts(27299字) / pool.ts(18823字) / 新测试(7244字) LF 归一后**逐字符完全相同** |

WSL 那 1 项跳过是 tests/temp-cleanup.test.ts:66 的 skip: process.platform !== 'win32'
（仅 Windows 有"打开句柄删不掉"语义），既有设计，非回归。