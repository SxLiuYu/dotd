# 12 — 安全清理 + .gitignore + 文档

**What to build:** RTK.md 删除飞书 APP_ID/open_id/WiFi 密码/PID 等敏感信息（或加 .gitignore + git rm --cached）；.gitignore 补漏运行时数据文件；README 重写为产品向 5 分钟上手；新增 DEPLOYMENT/ESP32/DEMO_MODE 文档。开源发布前 ready。

**Blocked by:** 01, 08, 10, 11 — 所有功能 ticket 就绪后做发布前清理

**Status:** ready-for-agent

- [x] RTK.md 删第 59 行飞书 APP_ID/open_id、第 86 行 WiFi 密码、PID 等
- [x] 或 RTK.md 整个加 .gitignore + git rm --cached RTK.md
- [x] .gitignore 补：episodic_memories.json / decision_*.json / pushed_hot_topics.json / protocols.json / data/ / workspace/
- [x] 新建 scripts/check-leaks.sh：发布前扫描是否有真实 key 误入库
- [x] README.md 重写：5 分钟上手（Docker v1.1 / 桌面包 v1.0 双路径）+ 密钥获取指引
- [x] 新建 docs/DEPLOYMENT.md：每种部署方式完整步骤 + troubleshooting
- [x] 新建 docs/ESP32.md：固件烧录、NVS patch、OTA 配置
- [x] 新建 docs/DEMO_MODE.md：Demo 规则模式的安装与使用
- [x] git grep 敏感词（APP_ID/secret/password 开头的真实值）无结果
