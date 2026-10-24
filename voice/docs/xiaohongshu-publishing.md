---
name: xiaohongshu-publishing
description: 通过 ego-browser 自动化发布/删除小红书笔记。
metadata:
  version: "1.0"
  date: "2026-08-05"
---

# 小红书发布

通过 ego-browser 自动化发布小红书图文笔记。**必须用 ego-browser**（隔离空间、复用登录态、不抢用户浏览器）。

## 发布流程（5步，2026-08-05 验证通过）

### 第1步：创建任务空间 + 打开发布页

```js
const task = await useOrCreateTaskSpace('小红书发帖')
await openOrReuseTab('https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=image', { wait: true, timeout: 20 })
await wait(3)
```

### 第2步：上传封面图

```js
await uploadFile('input[type="file"]', '/tmp/xhs_cover.png')
await wait(5)
```

### 第3步：填标题

用 `nativeInputValueSetter` 触发 React（`Input.insertText` 会卡死，不要用）：

```js
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
```

### 第4步：填正文

```js
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const editors = document.querySelectorAll('[contenteditable=true]');
    for (const ed of editors) {
      if (ed.offsetParent !== null) { ed.focus(); break; }
    }
    document.execCommand('insertText', false, ${JSON.stringify(bodyText)});
  })()`
})
await wait(1)
```

### 第5步：点击发布按钮（⚠️ 核心 — closed shadow DOM）

发布按钮是 `<xhs-publish-btn>` Vue 自定义元素，内部用 **closed shadow DOM** 渲染。普通 JS 无法访问。

**方案**（2026-08-05 验证通过）— AX 树 + DOM.resolveNode + callFunctionOn：

```js
await scrollBy(800)
await wait(1)

const tree = await cdp('Accessibility.getFullAXTree')
let backendNodeId = null
for (const node of tree.nodes || []) {
  const name = (node.name || {}).value || ''
  const role = node.role || ''
  if (name === '发布' && role === 'button') {
    backendNodeId = node.backendDOMNodeId
    break
  }
}

const resolved = await cdp('DOM.resolveNode', { backendNodeId })
await cdp('Runtime.callFunctionOn', {
  objectId: resolved.object.objectId,
  functionDeclaration: "function() { this.click(); return 'clicked'; }",
  returnByValue: true
})
await wait(10)
```

### 第6步：验证

```js
const info = await pageInfo()
cliLog('URL: ' + info.url)
// 成功标志：URL 包含 'publish/success'
```

## 删除笔记流程

1. **笔记管理页**：`https://creator.xiaohongshu.com/new/note-manager`（旧路径已 404）
2. hover 卡片触发操作按钮，点击删除按钮（class 含 `--del`）
3. 确认弹窗点击"确定"（**SPAN** 元素，不是 button）
4. 验证：笔记数减1

## 已知陷阱

1. 三个"发布"按钮：侧边栏=导航跳转、文字配图=无按钮、编辑页底部=真正的发布按钮
2. 不要用"文字配图"模式，直接上传图片文件
3. `ref` 跨会话不固定，不能用硬编码
4. `click('@ref')` 对 shadow DOM 按钮无效，必须用 AX 树方案
5. `Input.insertText` 可能卡死，用 `nativeInputValueSetter` + `execCommand`
6. 封面图用 3:4 竖版（1080×1440）

## 文案风格

- **极简**：4-6行短句，不加分段说明
- **不要技术参数**（毫秒、per值、模型名）
- **多项优化合并到一条帖子发**，不拆分

## 完整脚本模板

```js
const task = await useOrCreateTaskSpace('小红书发帖')
await openOrReuseTab('https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=image', { wait: true, timeout: 20 })
await wait(3)
await uploadFile('input[type="file"]', '/tmp/xhs_cover.png')
await wait(5)

await cdp('Runtime.evaluate', {
  expression: `(function() {
    const input = document.querySelector('input[placeholder="填写标题会有更多赞哦"]');
    if (input) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'AI语音助手Charlie');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`
})
await wait(1)

await cdp('Runtime.evaluate', {
  expression: `(function() {
    const editors = document.querySelectorAll('[contenteditable=true]');
    for (const ed of editors) {
      if (ed.offsetParent !== null) { ed.focus(); break; }
    }
    document.execCommand('insertText', false, ${JSON.stringify(bodyText)});
  })()`
})
await wait(1)

await scrollBy(800)
await wait(1)

const tree = await cdp('Accessibility.getFullAXTree')
let backendNodeId = null
for (const node of tree.nodes || []) {
  const name = (node.name || {}).value || ''
  const role = node.role || ''
  if (name === '发布' && role === 'button') {
    backendNodeId = node.backendDOMNodeId
    break
  }
}
if (backendNodeId) {
  const resolved = await cdp('DOM.resolveNode', { backendNodeId })
  await cdp('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: "function() { this.click(); return 'clicked'; }",
    returnByValue: true
  })
  await wait(10)
  const info = await pageInfo()
  cliLog('发布结果 URL: ' + info.url)
  if (info.url.includes('publish/success')) cliLog('✅ 发布成功！')
  else cliLog('⚠️ 未跳转 success')
}
```