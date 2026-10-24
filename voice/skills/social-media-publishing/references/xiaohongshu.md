# 小红书 (Xiaohongshu) 完整发布流程

## 发布页 URL

```
https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=image
```

需要先登录：`openOrReuseTab('https://www.xiaohongshu.com')` 确认登录状态，再导航到发布页。

## 两种发布路径

### 路径 A：图片上传模式（推荐 — 有真正的发布按钮）

文字配图模式生成的图片无法直接发布（编辑器内没有发布按钮，侧边栏"发布笔记"是导航菜单点击会跳走）。需要改用图片上传模式：

1. 进入发布页：`https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=image`
2. 页面上有"上传图片"和"文字配图"两个按钮，点击"上传图片"旁边的 file input 区域
3. 用 CDP 上传图片文件：
```js
const doc = await cdp('DOM.getDocument', { depth: -1 })
const qResult = await cdp('DOM.querySelector', {
  nodeId: doc.root.nodeId,
  selector: 'input[type="file"]'
})
await cdp('DOM.setFileInputFiles', {
  nodeId: qResult.nodeId,
  files: ['/tmp/xhs_cover.png']
})
```
4. 上传后进入图片编辑+发布页面，包含：
   - 标题输入框：`input[placeholder="填写标题会有更多赞哦"]` — 用 `cdp('Input.insertText', { text: '标题' })`
   - 正文输入框：contenteditable textfield — 用 `document.execCommand('insertText', false, text)`
   - 话题标签推荐区
   - **发布按钮**：页面底部，与"定时发布"checkbox 并列，文字为"发布"（不是"发布笔记"）
5. 用 `snapshotText()` 找到"发布"按钮的 ref，`click('@REF')` 点击
6. 验证 URL 跳转到 `publish/success`

**可以用 PIL 预先生成封面图**（1080x1440, 3:4 比例），在封面图上写好标题和要点文字。字体用 `/System/Library/Fonts/STHeiti Medium.ttc`。

### 路径 B：文字配图模式（可生成 AI 封面但发布困难）

文字配图模式可以输入文案后用 AI 生成封面图，但**编辑器内没有发布按钮**，侧边栏的"发布笔记"是导航菜单不是发布按钮，点击会跳到视频上传页。如果要用此模式，需要先生成图片，然后切到路径 A 上传生成的图片。

## 完整步骤（2026-08-04 验证通过 — 路径 A）

### 第1步：创建任务空间
```js
const task = await useOrCreateTaskSpace('小红书发帖')
```

### 第2步：进入文字配图模式
1. 打开页面：`openOrReuseTab(url, { wait: true, timeout: 20 })`
2. 点击"文字配图" — 用 CDP 鼠标事件点坐标

### 第3步：输入文案
```js
await cdp('Runtime.evaluate', {
  expression: `document.execCommand('insertText', false, ${JSON.stringify(copyText)});`
})
```
注意：`type()` 和 `fillForm()` 不存在于 ego-browser Node.js 运行时。

### 第4步：生成图片
1. 点击"生成图片"文字（CDP 鼠标事件）
2. 等待 5-8s 让 AI 生成完成
3. 出现风格选项：基础/插图/涂鸦/边框/便签/光影/简约/涂写/几何/备忘/弥散

### 第5步：选风格 + 下一步
1. 点击选中的风格文字（如"几何"）
2. 点击"下一步"按钮

### 第6步：填标题
```js
document.execCommand('insertText', false, '我做了一个AI语音助手')
```
标题建议 ≤20 字，精简。

### 第7步：发布
1. 用 `snapshotText()` 找到"发布"按钮的 ref（在页面底部，与"暂存离开"并列）
2. 用 `await click('@REF', { label: '点击发布' })` 点击
3. 验证 URL 跳转到 `publish/success`

## 文案风格建议

用户偏好：**极简**（每行短句，4-6行，不加分段说明，不要技术细节）。用户明确反馈"应该简单一点"——技术参数（毫秒、per=3等）不要出现在帖子中。

**⚠️ 内容组合规则（2026-08-04 用户纠正）**：当同时做了多项优化时，**合并到一条帖子发**，不要只选一个主题。用户最开始说"只需要写大脑模型优化"，但发完后纠正"为什么只发了一条，不是有四条优化吗"，最终要求"4条合并到一条帖子里"。正确做法：把所有优化项合并为一条极简帖子，不加分段说明，末尾加"由AI自主决策发布"。

**正确示例（用户认可 — 单一主题）**：
```
做了一个AI语音助手Charlie
大脑切到火山引擎ARK
响应更快，说话更利索
由AI自主决策发布
```

**错误示例（用户拒绝 — 铺开太多细节）**：
```
1 ASR修复：百度优先，从4秒降到450毫秒
2 Token持久化：重启不再冷启动
3 TTS音色改度逍遥，成熟男声
4 占用语过滤：让我想想不再被合成
```

## AI 发布披露

用户要求：AI 自主发布的帖子末尾加上 `由AI自主决策发布`，让读者知道这是 AI 自动发布的的内容。

## 已知陷阱

### 陷阱1：三个"发布"按钮，只有一个是真的
- 侧边栏 `div.publish-video` 的"发布笔记" → **导航菜单**，点击跳到视频上传页（target=video），不是发布！
- 文字配图编辑器内**没有发布按钮** — 无法从此模式直接发布
- 图片上传后的编辑页底部 `<button>发布</button>` → **真正的发布按钮**（与"定时发布"checkbox 并列）
- 每次需要重新获取 snapshotText 确认 ref

### 陷阱2：React 事件不响应 DOM click
- 程序化 `.click()` 可能不触发 React 合成事件
- 必须用 CDP 真实鼠标事件

### 陷阱3：图片编辑弹窗
- 发布前可能弹出"图片编辑"对话框（裁剪器）
- 含比例选择（原始/1:1/3:4/4:3）和取消/确定按钮
- 需要先点确定关闭，再重新点发布

### 陷阱4：按钮不在 DOM 中
- `snapshotText()` 能看到全 accessibility tree
- `document.querySelectorAll('button')` 可能找不到滚动区域外的按钮
- 先滚动容器到底部再查

### 陷阱5：截图超时
- 生成图片后或发布后，`captureScreenshot()` 可能超时
- 用 `pageInfo()` + `snapshotText()` 替代验证

### 陷阱6：任务空间卡住
- 导航超时后 task space 可能卡住
- 关闭所有旧 tab，用新名称创建新空间

### 陷阱7：点击"上传图文"会进入文字配图编辑器而非文件上传

在小红书发布页（target=image），点击"上传图文"按钮（或"文字配图"按钮）**都会进入文字配图编辑器**（contenteditable textfield + AI生成图片），而不是文件上传界面。文字配图编辑器内**没有发布按钮**，侧边栏"发布笔记"是导航菜单点击会跳到视频页。

**所以小红书发布的正确路径就是直接上传图片，不用文字配图编辑器。**

**正确方式** — 要上传图片文件，需要在发布首页**直接用 CDP 找 `input[type="file"]`** 上传，不要点击任何按钮：
```js
// 发布首页直接上传图片（不点"上传图文"按钮）
const doc = await cdp('DOM.getDocument', { depth: 0 })
const qResult = await cdp('DOM.querySelector', {
  nodeId: doc.root.nodeId,
  selector: 'input[type="file"]'
})
await cdp('DOM.setFileInputFiles', {
  nodeId: qResult.nodeId,
  files: ['/tmp/xhs_cover.png']
})
// 上传后自动进入图片编辑+发布页（有真正的发布按钮）
await wait(5)
```

上传后页面自动跳转到图片编辑+发布页，snapshotText 可以看到：
- 标题输入框：`input[placeholder="填写标题会有更多赞哦"]`，ref 动态变化
- 正文编辑区：contenteditable textfield，ref 动态变化
- **发布按钮**：页面底部，文字为"发布"，与"定时发布"checkbox 并列，ref 动态变化

注意：发布首页的 file input 可能宽高为 0（隐藏的），但 CDP `DOM.setFileInputFiles` 仍能操作。上传后页面自动跳转到图片编辑+发布页，包含标题框、正文框、话题标签、底部"发布"按钮。

### 陷阱8：发布页的正文 textfield ref 跨会话不固定

小红书发布页是 Vue SPA，textfield 的 accessibility ref 每次打开页面随机生成。**每次必须重新 `snapshotText()` 获取 ref**，不能硬编码。`snapshotText()` 的输出中 `textfield [ref=NNN, loc=unstable]` 的 ref 每次都会变。用 `document.execCommand('insertText', false, text)` 插入文本（不依赖 ref）。

### 陷阱9：发布成功后跳转 `publish/success`

小红书发布成功后 URL 跳转到 `https://creator.xiaohongshu.com/publish/publish/success`，页面显示"发布成功"。用 `pageInfo().url.includes('publish/success')` 或 `snapshotText()` 中找"发布成功"文字来验证。

### 陷阱10：XHS-PUBLISH-BTN 是 closed shadow DOM（2026-08-04 最终解决）

小红书发布按钮 `<xhs-publish-btn>` 是 Vue 自定义元素，内部用 **closed shadow DOM** 渲染。

- `submit-text=发布` `submit-disabled=false` 是属性，不是文本节点
- 普通 JS `document.querySelector` 找不到内部按钮，`el.shadowRoot` 返回 null（closed mode）
- `snapshotText()` 只显示 `<xhs-publish-btn>` 标签，看不到内部按钮
- `document.querySelectorAll('button')` 找不到发布按钮（在 shadow DOM 内）
- `Input.insertText` 和 `snapshotText()` 在上传图片后可能永久卡死，不要用

**唯一可行方案** — 用 CDP `DOM.getDocument` 配合 `pierce: true` 穿透 shadow DOM：

```js
// 1. 获取 pierce=true 的 DOM 树
const doc = await cdp('DOM.getDocument', { depth: -1, pierce: true })

// 2. 递归搜索 shadow DOM 内的文本节点 "发布"
function findTextNode(node) {
  if (node.nodeName === '#text' && node.nodeValue === '发布') return node
  for (const child of node.children || []) {
    const r = findTextNode(child); if (r) return r
  }
  for (const sr of node.shadowRoots || []) {
    const r = findTextNode(sr); if (r) return r
  }
  return null
}

// 3. 找到文本节点的父 BUTTON，获取坐标
const textNode = findTextNode(doc.root)
const box = await cdp('DOM.getBoxModel', { nodeId: textNode.parentId })
const content = box.model.content
const cx = (content[0] + content[2] + content[4] + content[6]) / 4
const cy = (content[1] + content[3] + content[5] + content[7]) / 4

// 4. 用 Input.dispatchMouseEvent 点击
await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
```

Shadow DOM 内部结构（pierce 后可见）：
- `<style>` — 按钮样式（`.ce-btn.bg-red` 红色背景 `#ff2442`）
- `<div data-v-app>` → `<div class="publish-page-publish-btn">` → 两个 `<button>`
  - `<button class="ce-btn white">暂存离开</button>`
  - `<button class="ce-btn bg-red" aria-disabled="false">发布</button>` ← 这个

**不要用** `Runtime.evaluate` 直接 `.click()` shadow DOM 内的按钮 — React/Vue 合成事件可能不响应。必须用 CDP `Input.dispatchMouseEvent` 真实鼠标事件。

**补充（2026-08-04 最终验证）**：`Input.dispatchMouseEvent` 坐标点击在某些情况下也不生效（可能是 ProseMirror 编辑器焦点干扰）。**最可靠方案**是用 CDP `DOM.resolveNode` + `Runtime.callFunctionOn` 直接在 shadow DOM 内的按钮上执行 `this.click()`：

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

注意：`this.shadowRoot.querySelector` 在 closed shadow DOM 上返回 null，但 `DOM.resolveNode` + `Runtime.callFunctionOn` 可以直接操作 shadow DOM 内的元素。

**填标题和正文的正确方式**（避免 `Input.insertText` 卡死）：
```js
// 填标题 — 用 nativeInputValueSetter 触发 React
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const input = document.querySelector('input[placeholder="填写标题会有更多赞哦"]');
    if (input) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '标题文字');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`
})

// 填正文 — 用 execCommand
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const editors = document.querySelectorAll('[contenteditable=true]');
    for (const ed of editors) {
      if (ed.offsetParent !== null) { ed.focus(); break; }
    }
    document.execCommand('insertText', false, '正文内容');
  })()`
})
```

## 删除已发布笔记

需要删除/重发笔记时的操作流程（2026-08-04 验证通过）：

1. **笔记管理页 URL 已变更**：旧路径 `publish/manage` → 404，新路径 `https://creator.xiaohongshu.com/new/note-manager`，或从首页点击"笔记管理"
2. hover 笔记卡片触发操作按钮显示：
```js
// hover 卡片使 note-card__actions 出现
card.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}))
card.dispatchEvent(new MouseEvent('mousemove', {bubbles: true}))
```
3. hover 后卡片右上角出现4个 `span.note-card__action-btn`，最后一个带 `--del` 后缀
4. 用 CDP 鼠标事件点击删除按钮（class 含 `note-card__action-btn--del`）
5. 弹出确认弹窗"删除后将无法恢复"，点击"确定"按钮
6. **关键坑**："确定"按钮是 `SPAN.circle-button-content` 文本节点，**不是 `<button>`**，`querySelector('button')` 找不到
   - 需要用 `document.querySelectorAll('span')` 搜索文本内容为"确定"的 SPAN
   - 或用 CDP `DOM.getBoxModel` 获取 SPAN 坐标后用 `Input.dispatchMouseEvent` 点击
7. **坑**：搜索结果中第一条笔记的删除按钮坐标可能与未搜索时第一条（置顶笔记）相同，需确认弹窗中的笔记标题匹配

### PIL 生成封面图模板

```python
from PIL import Image, ImageDraw, ImageFont
font_path = "/System/Library/Fonts/STHeiti Medium.ttc"
img = Image.new("RGB", (1080, 1440), (26, 26, 46))  # 3:4 比例
draw = ImageDraw.Draw(img)
title_font = ImageFont.truetype(font_path, 80)
sub_font = ImageFont.truetype(font_path, 48)
# 居中文字
bbox = draw.textbbox((0,0), text, font=font)
x = (1080 - (bbox[2]-bbox[0])) // 2
draw.text((x, y), text, fill=color, font=font)
img.save("/tmp/xhs_cover.png")
```