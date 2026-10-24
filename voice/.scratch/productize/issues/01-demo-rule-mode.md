# 01 — Demo 规则模式（核心）

**What to build:** 无 LLM/无 key 时 Charlie 仍能完成简单对话。用户说"几点了"→Charlie 报时间；说"晚安"→触发 goodnight 场景；快路径都不命中→提示"Demo 模式能力有限，请配置 key 解锁完整能力"。这是 v1.0 桌面包 3 分钟验收的基础——零配置可用。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] mock LLM 不可用（ARK_KEY 空 + Ollama 离线），输入"几点了"返回含当前时间的文本
- [x] mock LLM 不可用，输入"晚安"触发 goodnight 场景步骤
- [x] mock LLM 不可用，输入无法命中的内容（如"今天天气"），返回固定提示串引导配置 key
- [x] system_msg 在 Demo 模式下加横幅"能力有限，配置 key 解锁完整能力"
- [x] 现有 51 个测试不破坏
