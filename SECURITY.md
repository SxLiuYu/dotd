# 安全策略

## 报告漏洞

**不要开公开 issue。** 用 GitHub 的私密漏洞报告（Security → Advisories → Report a vulnerability），
或发邮件到 `yujinze000@163.com`。请在报告里写：影响版本/提交、复现步骤、影响面、
你希望的披露时间。我们会在 7 天内确认，修复后在 release notes 里致谢（除非你要求匿名）。

## 设计里已经钉死的边界

- **设备令牌 ≠ 主人令牌**：设备只能走 `/api/device/*`，访问管理面返回 403
  （有身份、无权限），不是 401。
- **语音不能批准危险动作**：`/api/device/approvals/:id` 恒 403 并写审计。
- **设备令牌只存 sha256**：明文只在创建时返回一次，可轮换、可吊销。
- **执行凭证**：`/api/tasks/:id/proof` 默认只给 hash，`?args=1` 才给参数预览。
- **默认只监听回环**：扩到局域网必须显式配置 `DOTD_HTTP_HOST`，鉴权边界只会收紧。
- **主动推送有闸**：总开关 / 安静时段 / 每日上限 / 节流 / 同文去重，决策写
  `device_push_log`。

## 部署注意

- 不要把 `.env`、`tokens.env`、`~/.dotd/` 提交或打进镜像。
- 对外暴露 HTTP 前必须换掉示例 master token，并配置 `allowed_origins`。
- `DOTD_FLEET=stub` 只用于测试；真机运行用 Docker，且容器不要挂载宿主机根目录。
- 上游 `voice/charlie/` 的工具包含红外/家电控制等**物理副作用**，首次使用请逐项
  缩小权限范围；语音侧不提供「一句话授权」。

## 支持范围

只支持仓库当前主分支 + 最近一次 release。旧版本的安全修复会尽量回移，但不承诺。
