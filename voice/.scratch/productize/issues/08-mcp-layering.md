# 08 — MCP 分层 + mcp_gate key 缺失跳过

**What to build:** MCP_PROFILE=core（默认）只启 8 个核心 MCP；MCP_PROFILE=all 启 19 个；MCP_PROFILE=custom 读 MCP_SERVERS。Demo 模式（无 LLM）强制不启 MCP。可选 MCP 的 key 缺失时自动跳过 + log warning。

**Blocked by:** 01 — Demo 模式判断共享（voice_agent._demo_mode_active）

**Status:** ready-for-agent

- [x] voice_agent all_mcp 拆成 CORE_MCP（8个：时间/天气/记忆/提醒/系统/翻译/计算/搜索/备忘录）+ OPTIONAL_MCP（11个）
- [x] 读 MCP_PROFILE 环境变量：core/all/custom
- [x] Demo 模式（_demo_mode_active()）时强制 mcp_set="none"
- [x] 新建 app/mcp_gate.py：每个可选 MCP 声明 required_env，启动前过滤 key 缺失的
- [x] _build_brain 拿过滤后的 enabled_mcp 列表传给 qwen-agent
- [x] MCP_PROFILE=core 启动日志显示 8 个 MCP
- [x] Demo 模式启动日志显示 0 个 MCP
- [x] 飞书 MCP 缺 FEISHU_APP_ID 时自动跳过 + warning
