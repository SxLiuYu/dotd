# 04 — setup 路由 + env_catalog 整合 + 分组卡片

**What to build:** 访问 /setup 看到按分组（核心/飞书/Tuya/ESP32/...）的卡片，每张卡片显示每个 key 的状态（已配置/缺失/Demo可用）；保存时宽松校验——缺必需项但勾选"Demo 模式"可保存。env_catalog 作为单一来源驱动 setup。

**Blocked by:** None — env_catalog 已存在

**Status:** ready-for-agent

- [x] _validate_env 从 env_catalog 动态生成，按分组打印状态
- [x] _SETUP_WHITELIST 从 env_catalog.setup_whitelist_keys() 派生
- [x] post_setup 校验放宽：缺必需 + demo_accept=true 可保存
- [x] get_setup 返回 env_catalog.setup_payload() + __demo_mode/__llm_available/__missing_required
- [x] 新增 GET /api/setup/mcp-status 返回分组结构
- [x] setup.html 分组卡片渲染（拉 /api/setup/mcp-status + /api/setup）
- [x] setup.html 缺失必需项时显示 Demo 勾选框
- [x] _write_env_file 保留原 .env 注释和顺序（不覆盖值为空的字段）
