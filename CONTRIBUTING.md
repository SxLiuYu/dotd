# 贡献指南

dotd 的原则只有一条：**能跑、能证、不吹**。改动必须留下可重跑的证据。

## 开始之前

```bash
npm run setup:all     # Node + Python 依赖 + 体检
npm test              # 全量门禁（约 60–90 秒）
npm run typecheck     # tsc --noEmit
npm run voice:test    # Python 侧的桥/分流/记忆/推送/音频
```

- 需要 Node ≥ 22（实际开发用 24），Python ≥ 3.10。
- 没有 Docker 时用 `DOTD_FLEET=stub`；**stub 的写入不会落盘**，别拿它当验收环境。
- 不要在仓库里放密钥。配置在 `~/.dotd/`，模板在 `config/` 和 `.env.example`。

## 提交前自检

1. `npm run typecheck` 与 `npm test` 全绿；
2. 新增行为有测试；修复 bug 先写一条会失败的用例，再修；
3. 文档里写「已验证」时，必须给命令或证据文件路径；
4. 涉及记忆/推送/设备面的改动，跑一遍 `npm run voice:test`。

## 语音目录的边界

`voice/charlie/` 是 vendored 上游代码（见 `voice/VENDOR.md` 与 `voice/NOTICE`）。
**不要直接改上游文件**——把行为改动放进 `voice/integration/`，用运行时接缝接管。
必须改上游时，先回上游提 PR，再升级整目录。

## 提交信息

用中文写清「为什么」，而不是「改了什么」。一次提交只做一件事。
涉及安全边界的改动（设备令牌、审批、凭证、出网）请在正文里写明威胁模型与测试。

## 许可证

提交即表示你同意以仓库根目录的 Apache-2.0（`LICENSE`）与 `voice/` 下的 MIT
（`voice/LICENSE`）双许可发布你的贡献。第三方代码必须保留原许可并在
`voice/NOTICE` 或 `THIRD_PARTY.md` 里登记。
