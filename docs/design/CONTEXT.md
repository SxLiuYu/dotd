# 自主 Dot 系统（工作名 dotd）— 设计背景与已定方向

本文件是所有模块设计的共同契约。模块架构师**不得推翻**这里的决策；如与常识/惯例冲突，以本文件为准。

## 目标

自研一个类 OpenAI Dots 的常驻个人 AI Agent 系统。诉求优先级：

1. **完全自主**：不依赖任何商业托管服务（排除 CopilotKit Intelligence 这类闭源云）。会话、记忆、任务队列、执行环境全部自持有。唯一允许的外部依赖 = 模型 API，且 `base_url` 可热切换，换供应商改一行配置。
2. **好用**：日用级交互体验，不做玩具。
3. **模型层自主容灾**：配置内模型全部不可用 → 自动降级 → 探测策展免费池 → 侦察互联网候选（只侦察不接入，接入必须主人批准）→ 全程发求救消息。

## 已定总体架构（模块边界）

```
┌─ 交互面: 本地 Web UI(聊天+审批卡片+队列/熔断状态) + Telegram bot + CLI
├─ 事件入口: HTTP/webhook · JSONL 文件监听 · 心跳调度器 · 邮件(阶段二)
├─ 控制面: TypeScript 单进程 daemon(Node 24) + SQLite(任务队列/journal/审批/事件日志/会话历史/熔断状态)
├─ 治理: 工具权限分级 + 审批状态机(Web卡片/Telegram回复双通道) + 执行前后审查 + 审计日志
├─ 执行面: 每 Dot 一个 Docker 容器(Playwright+stealth / 每身份持久浏览器profile卷 / /dot/home 文件记忆卷 / 文件·shell·浏览器工具)
├─ 记忆: 两层 — 文件记忆(/dot/home 笔记与操作手册, 任务开始时读、结束时写) + SQLite 会话历史。起步不上向量库。
└─ 模型路由: ModelRouter 三级降级阶梯 + 熔断器(SQLite持久化) + 策展免费池(free-models.yml) + 互联网侦察(需批准) + 求救通道(Telegram优先, email兜底, 再不行写 OUTBOX.md)
```

模型层既定事实：
- 主 Agent 循环走 **OpenRouter**（OpenAI 兼容），高质量工具调用能力必需，本地 7B 撑不起主循环。
- **双轨路由**：事件路由/分流/摘要等低智能高频调用可路由到本地 Colibrì 或 Ollama。
- 求救消息频率限制：同一故障 24h 只求救一次；恢复时发通报。
- 应急模式（用免费池/侦察候选时）自动收缩任务范围：低危工作可跑，浏览器登录态操作强制转审批。

## 机器约束（设计必须贴合）

- Windows 10 / 双路 Xeon 共 72 核（分属两个 processor group，进程需显式亲和性处理，历史上落错组损失 28% 性能）/ 64 GB RAM / **无 GPU**。
- WSL Ubuntu-24.04 有 Docker daemon 29.1.3；宿主机无 docker。控制面 daemon 跑 WSL 内，Web UI 经 localhost 转发访问。
- WSL 内常年有 netfuzz/libFuzzer 负载占 ~20GB 内存与大量 CPU：设计需给出资源上限、预留与"与现有负载共存"策略，不能假设独占。
- 本地 Colibrì：OpenAI 兼容 API，OLMoE 7B，MoE-only，约 7 tok/s，需显式 residency cap，内存吃紧时不可靠——按"尽力而为"设计，路由到它时要能探测其不可用并再降级。
- C:/D: 盘都不大：容器镜像、卷、journal 都要有占用上限与回收策略。

## 参考项目（只借设计，零代码依赖；全部 MIT）

| 来源 | 借什么 | 不碰什么 |
|---|---|---|
| CopilotKit/OpenDots+OpenBot | 审批卡片 UX、"每 Agent 一台电脑"容器隔离、执行前后审查、scheduled turns | Intelligence 托管、CPK CLI 流程 |
| feder-cr/invisible_dots | 崩溃安全步骤级 journal（工具调用被打断绝不重复执行）、每身份独立持久浏览器 profile、文件记忆(把笔记写在自己 home)、"无遥测无服务端"哲学、Telegram 优先 | QEMU/KVM VM 路线（WSL 嵌套虚拟化不划算，我们用容器）、OpenRouter-only 写死（我们做成可换 base_url） |
| Shashankss1205/OpenDots | heartbeat/event/target 三概念、`serve` 常驻重启不丢队列、事件入口清单（HTTP POST/JSONL 监听/GitHub 轮询+webhook/心跳）、事件→目标匹配带置信度与理由、本地 127.0.0.1 Web UI | — |
| 通用反面教训 | 不用 WhatsApp（非官方客户端封号）；不接受任何"厂商账号+闭源服务"换持久化 | |

## 交付与分期

- 最终交付 = 一份可照着动工中文技术方案：总览与模块图 → 六模块详设 → 模块接缝端到端走查（事件→队列→模型→工具→审批→journal→回复）→ MVP 实施清单。
- **阶段一（MVP，约 2 周，单人单 Dot）**：daemon+SQLite 队列+journal、OpenRouter 主循环、Playwright 容器、文件记忆、CLI/Web 审批、心跳与 HTTP 事件入口、降级到本地。
- 阶段二：Telegram/邮件入口、低智能分流到本地模型、免费池+侦察+求救闭环、审批规则持久化。
- 阶段三：多 Dot、invisible_playwright 反检测增强、语音（明确最后做）。
