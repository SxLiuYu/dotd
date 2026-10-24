# Demo 规则模式

Demo 规则模式是 Charlie 的零配置可用能力——不填任何 key、不装 Ollama，也能完成简单语音对话。

## 工作原理

当 GLM_API_KEY（或备选 ARK_KEY）未配置且 Ollama 离线时，brain() 不调 LLM，走快路径回退：

```
用户语音 → ASR → brain() → 快路径命中? → 返回结果
                                  ↓ 未命中
                          返回"Demo模式能力有限，请配置key"
```

## 可用能力（无需 key）

| 快路径 | 示例 | 依赖 |
|---|---|---|
| 时间直答 | 「几点了」 | 无 |
| 场景 Protocol | 「晚安」→goodnight、「早安」→good_morning | 无（内置 4 个场景） |
| 视觉截屏 | 「看看屏幕」 | ffmpeg |
| 智能命令 | 「首页」「停止」等 | 无 |

## 不可用能力（需 key）

| 功能 | 需要的 key |
|---|---|
| 天气查询 | AMAP_KEY |
| 翻译/计算/新闻 | GLM_API_KEY（LLM，智谱免费）|
| 飞书推送 | FEISHU_APP_ID/SECRET |
| 空调控制 | TUYA_CLIENT_ID/ACCESS_KEY |
| 音乐播放 | ncm binary |
| 记忆/进化 | GLM_API_KEY（LLM）|

## 升级路径

1. **Demo 规则模式**（零配置）：报时间/场景/截屏
2. **Ollama 离线模式**：`ollama serve & ollama pull qwen3.5:2b` → 本地 LLM 对话（不调 MCP，小模型能力有限）
3. **完整模式**：填 GLM_API_KEY/百度/高德 → 全部能力（天气/翻译/记忆/飞书/空调/音乐 + 全部 MCP）

## 验收标准

3 分钟内完成一次 Demo 规则对话：
- 说「几点了」→ Charlie 报时间 ✅
- 说「晚安」→ 触发 goodnight 场景 ✅

## 配置

Demo 规则模式自动激活（GLM_API_KEY/ARK_KEY 均空 + Ollama 离线），无需手动配置。system_msg 会显示"Demo 模式"横幅提示。

填入 GLM_API_KEY 后即时生效，自动切换完整模式。
