---
name: social-media-publishing
description: 发布内容到中文社交媒体平台（小红书、抖音等）——通过 ego-browser 浏览器自动化。中文社交平台无公开 API，必须走浏览器自动化。覆盖完整发布流程、关键陷阱及验证方法。
metadata:
  version: "1.0"
  date: "2026-08-02"
---

# Social Media Publishing

通过 ego-browser 自动化发布到中文社交媒体平台。**必须使用 ego-browser**（非 macos-computer-use）——隔离空间操作、复用登录状态、不抢用户浏览器。

## 通用流程

1. `useOrCreateTaskSpace('平台名+发帖')` — 创建任务空间
2. `openOrReuseTab(平台发布页URL, { wait: true, timeout: 20 })` — 打开发布页面
3. 按平台特定流程操作（见各平台参考文件）
4. 验证发布成功（URL 跳转 / 成功提示）
5. `completeTaskSpace(id, { keep: false })` — 完成后关闭

### 发布前验证（2026-08-05 新增）

**必须在发布前做，用户反馈"最后一个功能没体现"是重复踩坑。**

1. 列出所有功能项（如 叙事性记忆、自主决策、场景自动化、自进化）
2. 检查小红书 **正文文案** 是否覆盖所有功能，不遗漏
3. 检查抖音 **幻灯片列表** `dy_slides` 条目数 === 功能数（封面不计入）
4. 生成后验证：`len(POSTS["dy_slides"]) == feature_count`
5. 用户反馈"少了一个"时，优先检查 `POSTS["dy_slides"]` 和 `POSTS["xhs_desc"]` 是否漏写条目

## 关键技巧（所有平台通用）

### 1. 填入文本
`type()` 和 `fillForm()` 不存在于 ego-browser Node.js 运行时。用 CDP：
```js
// 在 contenteditable textfield 中插入文本
await cdp('Runtime.evaluate', {
  expression: `document.execCommand('insertText', false, ${JSON.stringify(text)});`
})
```

### 2. 点击按钮（React 事件陷阱）
React 应用可能不响应程序化 `.click()`。用 CDP 真实鼠标事件：
```js
const pos = await js(String.raw`(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim() === '按钮文字' && e.children.length === 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width/2, y: r.y + r.height/2 };
})()`)
if (pos) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
}
```

### 3. 元素在 DOM 可见但 querySelector 找不到
- `snapshotText()` 看全 accessibility tree（含滚动区域外元素）
- `document.querySelectorAll('button')` 只返回 DOM 渲染的元素
- 如果是滚动容器问题：`document.querySelector('.publish-page-content').scrollTop = el.scrollHeight`
- 然后使用 `await click('@ref')` (ego-browser helper) 而非 `document.querySelector`

### 4. 发布按钮混淆
- 侧边栏/导航栏的"发布笔记"按钮（class `publish-video`）是**导航菜单**，点击跳到视频上传页，不是发布
- 文字配图编辑器内**没有发布按钮** — 无法从此模式直接发布
- **真正的发布按钮**在图片上传后的编辑页底部，文字为"发布"（不是"发布笔记"），与"定时发布"checkbox 并列
- 小红书发布推荐路径：用 PIL 生成封面图 → CDP `DOM.setFileInputFiles` 上传 → 填标题正文 → 点底部"发布"按钮
- 每次需重新 `snapshotText()` 获取最新 ref

### 4.1 抖音"审核通知"对话框阻塞发布
抖音上传视频后，页面可能弹出"审核通知"对话框（`dialog "审核通知"`），内容显示"加载中，请稍后^_^"。此对话框**遮挡发布按钮**，导致 `click('@ref')` 无法点击到发布按钮。

**解决方案**：
1. 先关闭对话框：`await click('@750', { label: '关闭审核通知' })` — close button `aria-label="close"`
2. 对话框关闭后可能立即重新弹出（抖音在加载审核结果）— 需要等待 5-10 秒让它加载完
3. 如果 `click()` 仍然被遮挡，用 JS 直接点击发布按钮（绕过对话框遮挡）：
```js
const clickResult = await cdp('Runtime.evaluate', {
  expression: `(function() {
    const allBtns = document.querySelectorAll('button, [role="button"]');
    for (const btn of allBtns) {
      if (btn.textContent.trim() === '发布' && btn.offsetParent !== null) {
        btn.click();
        return JSON.stringify({text: '发布', x: r.x, y: r.y, w: r.width, h: r.height});
      }
    }
    return '发布 button not found';
  })()`
})
```
4. 也可以用 JS 隐藏对话框：`document.querySelectorAll('[role="dialog"]').forEach(d => d.style.display = 'none')`
5. 发布成功后 URL 跳转到 `content/manage?enter_from=publish`，页面显示"审核中"和"发布成功"

### 4.2 小红书文件上传路径（实测可用）
小红书发布页 (`https://creator.xiaohongshu.com/publish/publish`) 的 file input `accept` 属性为 `.jpg,.jpeg,.png,.webp`，支持多选（`multiple`）。上传流程：
```js
// 1. 获取 file input 的 nodeId
const doc = await cdp('DOM.getDocument', { depth: 0 })
const qResult = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' })
// 2. 上传文件
await cdp('DOM.setFileInputFiles', { nodeId: qResult.nodeId, files: ['/tmp/cover.png'] })
// 3. 等待页面跳转到编辑页 (约3-5秒)
await wait(5)
// 4. snapshotText() 获取新的 ref (标题输入框、正文、发布按钮)
```
上传后页面跳转到编辑页，有标题输入框（`placeholder="填写标题会有更多赞哦"`）、正文区域（contenteditable div）、底部"发布"按钮。**
不推荐使用"文字配图"模式**，该模式没有发布按钮且无法上传自定义图片。

### 5. uploadFile() 参数是选择器不是文件路径
`uploadFile()` 第一个参数是 DOM 选择器（如 `input[type="file"]`），不是文件路径。传文件路径会报 `Invalid selector` 错误。
- **文件上传用 CDP**：`DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles`
- 详见 `references/douyin.md` 陷阱 #2

### 6. CDP 鼠标事件超时 — 改用 JS click
`click('@ref')` 内部用 CDP `Input.dispatchMouseEvent`，当目标元素不在视口内或页面在加载时会超时。
- **替代方案**：用 `js()` 执行 `element.scrollIntoView()` + `element.click()`
- React 应用通常响应 `element.click()`，不一定需要真实鼠标事件

### 6.1 `click('@ref')` 静默失败（React 未触发）— 2026-08-05 实测
`click('@ref')` 可能 **返回成功（无错误）但 React 事件处理器未触发**，页面不跳转。抖音发布实测：`click('@1564')` 返回成功，但 `pageInfo().url` 未变化，说明 CDP 鼠标事件到达 DOM 但 React 未响应。
- **检测方法**：`click('@ref')` 后立即检查 `pageInfo().url` 是否变化，或 re-snapshot 看按钮是否仍在
- **解决方案**：用 JS 直接查找并 click：
```js
const result = await cdp('Runtime.evaluate', {
  expression: `(function() {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent?.trim() === '发布') {
        btn.click();
        return 'clicked';
      }
    }
    return 'not found';
  })()`
})
```
- 注意：`document.querySelectorAll('button')` 找不到 shadow DOM 内的按钮。对于 shadow DOM 按钮，使用方案 10 的 `DOM.resolveNode` 方案。

### 7. 截图超时
- `captureScreenshot()` 可能超时（页面在加载/渲染中）
- 备选：`snapshotText()` + `pageInfo()` 作为较轻的验证方式

### 8. 任务空间卡住
- 页面 navigation 超时或截图超时后，task space 可能卡住
- 关闭所有旧 tab 并创建新 task space：`useOrCreateTaskSpace('新名称')`

### 9. 用户控制权
- `handOffTaskSpace(id)` 交给用户控制后，所有 agent 操作失败
- 用户说"继续"后，`takeOverTaskSpace(id)` 恢复

### 10. Closed Shadow DOM 按钮（Vue/React 自定义元素）
部分平台（如小红书 `<xhs-publish-btn>`）用 **closed shadow DOM** 渲染按钮。普通 JS 无法访问内部元素（`el.shadowRoot` 返回 null），`document.querySelectorAll('button')` 找不到，`snapshotText()` 只显示外层自定义标签。

**三层递进方案**（按可靠性排序）：

**方案 A — CDP `Input.dispatchMouseEvent` 坐标点击**（有时不生效，ProseMirror 等编辑器焦点会干扰）：
```js
const doc = await cdp('DOM.getDocument', { depth: -1, pierce: true })
// 递归搜索 shadow DOM 内的文本节点
function findTextNode(node) {
  if (node.nodeName === '#text' && node.nodeValue === '发布') return node
  for (const child of node.children || []) { const r = findTextNode(child); if (r) return r }
  for (const sr of node.shadowRoots || []) { const r = findTextNode(sr); if (r) return r }
  return null
}
const textNode = findTextNode(doc.root)
const box = await cdp('DOM.getBoxModel', { nodeId: textNode.parentId })
// 计算中心坐标 → Input.dispatchMouseEvent
```

**方案 B — `DOM.resolveNode` + `Runtime.callFunctionOn`**（最可靠，2026-08-04 最终验证通过）：
```js
// 1. pierce=true 找到 shadow DOM 内的 BUTTON 节点
const doc = await cdp('DOM.getDocument', { depth: -1, pierce: true })
// 递归搜索 BUTTON 含子文本 "发布"
// 2. resolve to remote object
const resolved = await cdp('DOM.resolveNode', { nodeId: btn.nodeId })
// 3. callFunctionOn 执行 click
await cdp('Runtime.callFunctionOn', {
  objectId: resolved.object.objectId,
  functionDeclaration: "function() { this.click(); return 'clicked'; }",
  returnByValue: true
})
```

**注意**：`this.shadowRoot.querySelector` 在 closed shadow DOM 上返回 null（从外层元素访问），但 `DOM.resolveNode` + `Runtime.callFunctionOn` 可以直接操作 shadow DOM 内的元素（CDP pierce 模式获取的 nodeId 可以 resolve）。

**填标题和正文**（避免 `Input.insertText` 卡死）：用 `nativeInputValueSetter`（标题）+ `execCommand('insertText')`（正文），不要用 `Input.insertText`。详见 `references/xiaohongshu.md` 陷阱10。

### 11. 抖音上传页 file input 数量不固定
抖音上传页 (`/content/upload`) 的 file input 数量**随页面变体变化**：
- 2026-08-04 变体：两个 input — 第一个 `accept=video/*`（隐藏），第二个 `accept=image/*`（可见），需取 `nodeIds[1]`
- 2026-08-05 变体：一个 input — 直接是图片 input，取第一个即可

**可靠做法**：上传前先检查 `document.querySelectorAll('input[type="file"]').length`，如果为 1 直接用，如果为 2 取第二个。详见 `references/douyin.md` 图文发布章节。

## 验证发布成功

- URL 变化（如 `publish/success`）
- 页面包含"发布成功"、"审核中"等文字
- `pageInfo().url.includes('success')`

## 视频制作（PIL + ffmpeg）

抖音视频需要在发布前生成。**必须用 Python PIL 生成文字幻灯片**——macOS Homebrew ffmpeg 无 drawtext 滤镜。字体用 `/System/Library/Fonts/STHeiti Medium.ttc`（PingFang.ttc 路径不存在）。TTS 语音方案（按优先级）：① Hermes `text_to_speech` 工具（Edge TTS，音色自然，适合短视频配音）；② 百度 per=3 度逍遥（项目语音助手自身用的 TTS）。Finna qwen3-tts-flash 实测返回空音频不可用。详见 `references/video-generation.md`。

**用户质量要求**：文字清晰无乱码、语音清楚、音色好。本地 Qwen3-TTS-0.6B 音色差不要用。

**AI 发布披露**：用户要求 AI 自主发布的帖子/视频末尾加上 `由AI自主决策发布`。小红书加在正文末尾，抖音加在作品简介末尾。

**抖音格式偏好**：用户反馈 AI 生成的视频质量差（文字幻灯片+TTS 太粗糙），要求改用**图文格式**发布。抖音图文用 3:4 竖版图片（PIL 生成），每页一条优化，不上传视频。发布流程见 `references/douyin.md` 图文发布章节。

**封面图生成模板**：`templates/cover_geometric.py` — PIL 几何风格封面图生成脚本，修改 POSTS 字典即可复用。生成小红书 1 张封面 + 抖音 N 张幻灯片到 /tmp/。深色底+青绿主色+白色文字，简约大气风格。

**⚠️ 幻灯片数量验证（2026-08-05 踩坑）**：`POSTS["dy_slides"]` 中的条目数**必须等于功能数量**（不是 features - 1，也不是随便写）。4 个功能 = 4 个幻灯片条目（封面单独生成，不计入 slides）。生成后**立即验证**：`len(POSTS["dy_slides"]) == feature_count`。如果用户反馈"最后一个功能没体现出来"或"少了一个"，优先检查 `POSTS["dy_slides"]` 的条目数是否与功能数一致。

## 平台特定流程

- **小红书**：参考 `references/xiaohongshu.md`
- **抖音**：参考 `references/douyin.md`

## 背景音乐（BGM）

**核心原则：视频文件本身必须含音频流。** 抖音网页版"添加音乐"**只添加音乐信息标签，不会给视频加声音**——页面底部明确写着"不影响作品声音"。如果视频无音轨，发布后完全没声音。用户验证过这个坑。

**用户偏好：不要AI生成BGM。** ffmpeg lavfi 合成的和弦/节拍听感差，用户明确拒绝"不要自己生成了"。需要真实音乐人作品。

### 正确流程：下载BGM → ffmpeg混入 → 上传

1. 下载一首真实BGM（见下方 ccMixter 方案）
2. `ffmpeg -y -i video.mp4 -i bgm.mp3 -c:v copy -c:a aac -shortest -map 0:v:0 -map 1:a:0 output.mp4`
3. 用 `ffprobe` 确认输出有音频流：`ffprobe -v error -show_streams output.mp4 | grep codec_type`（应有 `video` + `audio`）
4. 上传 output.mp4 到抖音

### 免费音乐下载（ccMixter — 唯一可靠源）
ccMixter 是唯一从终端能可靠下载的免费音乐库。其他免费源（Bensound、Pixabay、Mixkit、Uppbeat）全部 Cloudflare 拦截或需登录。
- **API 搜索**：`https://ccmixter.org/api/query?type=api&datasource=uploads&tags=electronic,instrumental&limit=8&format=json`
- **下载需要完整浏览器请求头**（否则 403 Forbidden）：`User-Agent` + `Accept: audio/*` + `Referer: https://ccmixter.org/files/<artist>/<id>`
- **裁剪到视频时长**：`ffmpeg -y -i full.mp3 -t 15 bgm_15s.mp3`
- **许可**：CC BY-NC 4.0（非商业，需署名）

### 抖音内置音乐库（仅添加音乐标签，不加盐声音）
抖音发布编辑页的"添加音乐"面板可以选热曲，但**只在视频底部显示音乐信息，不改变视频音轨**。如果视频已有音轨，可用此功能附加音乐标签。详见 `references/douyin.md` § "添加音乐"。