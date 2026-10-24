# 抖音创作者中心发布流程

抖音创作中心 (creator.douyin.com) 完整视频发布流程。2026-08-02 验证通过。

## 关键陷阱

### 1. URL 强制重定向
直接导航到 `creator.douyin.com/creator-micro/publish` 或 `/content-manager` 会**强制重定向到首页** (`/home`)。

**正确方式**：导航到首页后点击"高清发布"按钮 (ref=18)，会跳转到 `/content/upload` 页面。

### 2. 文件上传 — uploadFile() 不接文件路径
`uploadFile()` 的第一个参数是 DOM 选择器，不是文件路径。传文件路径会报 `Invalid selector` 错误。

**正确方式** — 用 CDP `DOM.setFileInputFiles`：
```js
const cdpResult = await cdp('DOM.getDocument', { depth: 0 })
const nodeId = await cdp('DOM.querySelector', {
  nodeId: cdpResult.root.nodeId,
  selector: 'input[type="file"]'
})
await cdp('DOM.setFileInputFiles', {
  files: ['/tmp/path/to/video.mp4'],
  nodeId: nodeId.nodeId
})
```
上传后页面自动跳转到 `/content/post/video?enter_from=publish_page`（发布编辑页）。

### 3. 标题 vs 描述 — 两个不同的 DOM 元素
- **标题**：`input[placeholder="填写作品标题，为作品获得更多流量"]`，30字限制
- **描述/简介**：`div[contenteditable="true"]`，在标题下方，1000字限制

**陷阱**：用 `document.execCommand('insertText')` 填标题时，如果焦点没正确切换，描述文字会全部灌进标题框（30字立刻满）。

**正确方式** — 分别用不同方法：
```js
// 标题 — 用 native value setter (React 兼容)
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const inp = document.querySelector('input[placeholder="填写作品标题，为作品获得更多流量"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '标题文字');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`
})

// 描述 — contenteditable div，直接设 innerHTML
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const desc = document.querySelector('div[contenteditable="true"]');
    desc.focus();
    desc.innerHTML = '描述文字';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
  })()`
})
```

### 4. 发布按钮 — CDP 鼠标事件超时
发布按钮在页面底部，可能不在视口内。`click('@ref')` 通过 CDP `Input.dispatchMouseEvent` 可能超时。

**正确方式** — 用 JS `element.click()` + `scrollIntoView`：
```js
await js(`(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const pubBtn = btns.find(b => b.textContent.trim() === '发布');
  pubBtn.scrollIntoView({behavior: 'instant', block: 'center'});
  pubBtn.click();
})()`)
```

注意区分：
- "高清发布" (ref=18) — 顶部导航按钮，进入上传页
- "发布" (ref=1625左右) — 页面底部真正的发布按钮，与"暂存离开"并列

### 5. 发布成功验证
点击发布后：
- URL 跳转到 `creator.douyin.com/creator-micro/content/manage?enter_from=publish`
- 页面显示"发布成功"文字
- dialog 出现"审核通知"
- 作品列表中显示"审核中"

### 6. "审核通知"对话框遮挡发布按钮（2026-08-04 新增）

上传完成后，页面可能弹出一个"审核通知"对话框（dialog），显示"加载中，请稍后^_^"，**遮挡发布按钮**。关闭后可能再次弹出。

**正确方式** — 用 JS 隐藏对话框 DOM 元素，再用 JS 直接触发发布按钮点击（绕过遮挡）：
```js
// 1. 关闭对话框 close 按钮（ref 不稳定，用 aria-label 选择器更可靠）
await cdp('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="close"]')?.click()`
})
await wait(2)

// 2. 如对话框仍在，用 JS 隐藏所有 dialog 元素
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    dialogs.forEach(d => d.style.display = 'none');
    return 'removed ' + dialogs.length + ' dialogs';
  })()`
})
await wait(1)

// 3. 用 JS 直接触发发布按钮点击（绕过 DOM 遮挡）
await cdp('Runtime.evaluate', {
  expression: `(function() {
    const allBtns = document.querySelectorAll('button, [role="button"]');
    for (const btn of allBtns) {
      if (btn.textContent.trim() === '发布' && btn.offsetParent !== null) {
        btn.click();
        return 'clicked 发布';
      }
    }
    return '发布 button not found';
  })()`
})
await wait(5)
```

注意：对话框的 close 按钮 ref=750 在 iframe 内（iframe w=0, h=0 不可见），但 `click('@750')` 仍能通过 CDP 操作。

### 7. 备注"由AI自主决策发布"

用户要求：AI 自主发布的视频简介末尾加上 `由AI自主决策发布`，让读者知道这是 AI 自动发布的。在简介编辑区（contenteditable div）末尾添加。

## 完整发布流程

1. `useOrCreateTaskSpace('抖音发视频')`
2. `openOrReuseTab('https://creator.douyin.com/creator-micro/home', { wait: true, timeout: 20 })`
3. `await wait(3)` — 等页面加载
4. `await click('@18')` — 点击"高清发布"按钮 → 跳转到 `/content/upload`
5. `await wait(3)` — 等上传页加载
6. 用 CDP `DOM.setFileInputFiles` 上传视频文件
7. `await wait(15)` — 等上传完成，页面自动跳转到发布编辑页
8. 用 native value setter 填标题
9. 用 innerHTML 填描述 (contenteditable div)
10. `await js(...)` — JS click 发布按钮
11. `await wait(5)` — 等发布完成
12. 验证：URL 包含 `/content/manage`，页面包含"发布成功"

## 页面元素参考（可能随版本变化）

| 元素 | 选择器 | 说明 |
|------|--------|------|
| 高清发布按钮 | `@18` (不稳定) | 顶部导航，进入上传页 |
| 文件上传 input | `input[type="file"]` | CDP setFileInputFiles 目标 |
| 标题输入框 | `input[placeholder="填写作品标题，为作品获得更多流量"]` | 30字限制 |
| 描述编辑区 | `div[contenteditable="true"]` | 1000字限制 |
| 发布按钮 | `button` (textContent === "发布") | 页面底部，与"暂存离开"并列 |
| 立即发布选项 | `@1323` 左右 | 默认选中 |

## 添加音乐（抖音内置库）— ⚠️ 不影响视频声音

**关键陷阱**：抖音网页版"添加音乐"**不会给视频加声音**。页面底部明确写着"添加音乐仅影响作品底部音乐信息显示,不影响作品声音"。如果视频本身没有音轨，发布后播放完全没声音。用户验证过——"没有声音啊"。

**正确方案**：在上传前用 ffmpeg 把 BGM 混入视频文件（见 SKILL.md 的 BGM 章节），上传带音轨的视频。

抖音内置音乐库面板的操作流程仍记录在下方，适用于给已有音轨的视频追加"音乐标签"（影响信息展示，不影响实际声音）。

### 入口

- 页面右侧预览区下方，有一个"添加音乐"区域（含svg图标+文字）
- 旁边有"重新上传"按钮
- 整个区域是一个 `preview-button-r8SQPD` 容器，坐标约 x:1369, y:479

### 点击弹窗

**陷阱：React 合成事件不响应 JS `.click()`。** 必须用 CDP 真实鼠标事件或点击 mask 触发：

```js
// 1. 滚动到元素可见
await js(String.raw\`(() => {
  const el = document.querySelector('.preview-button-r8SQPD');
  if (el) el.scrollIntoView({behavior: 'instant', block: 'center'});
})()\`)
await wait(1)

// 2. 获取精确坐标
const c = await js(String.raw\`(() => {
  const el = document.querySelector('.preview-button-r8SQPD');
  const r = el.getBoundingClientRect();
  return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
})()\`)

// 3. CDP 真实鼠标事件
const {x, y} = JSON.parse(c)
await cdp('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y})
await cdp('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1})
await cdp('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1})
await wait(4)
```

### 音乐面板结构

打开后是一个右侧滑出面板（semi-sidesheet），包含：

| 区域 | 选择器 | 说明 |
|------|--------|------|
| 搜索框 | `input[placeholder="搜索音乐"]` | 输入关键词搜索 |
| 分类标签 | `tab` 元素 | 推荐、热门榜、收藏、飙升榜、原创榜、卡点、纯音乐、旅行、DJ、搞笑、流行、伤感 |
| 关闭按钮 | `semi-sidesheet-close` | 面板右上角X图标 |
| 使用按钮 | `button.apply-btn-LUPP0D` | 每首歌的"使用"按钮，hover才显示 |

### 搜索音乐（中文输入）

**陷阱：CDP `dispatchKeyEvent` 对中文输入无效。** 必须用JS设置value + 触发React事件：

```js
await js(String.raw\`(() => {
  const input = document.querySelector('input[placeholder="搜索音乐"]');
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(input, '科技');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // 触发回车开始搜索
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
})()\`)
await wait(4) // 等搜索结果加载
```

### 选择歌曲

搜索结果列表每首歌曲包含：名称、作者、时长、使用人数。"使用"按钮默认**隐藏**（display:none或opacity:0），hover到歌曲条目上才显示。

**陷阱：`.click()` 对隐藏按钮通常无效**。必须用JS绕过样式限制：

```js
await js(String.raw\`(() => {
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.children.length === 0 && el.textContent.trim() === '动感科技') {
      // 找到歌曲容器
      let songContainer = el;
      for (let i = 0; i < 5; i++) {
        if (!songContainer.parentElement) break;
        songContainer = songContainer.parentElement;
      }
      // 找到"使用"按钮
      const btn = songContainer.querySelector('button');
      btn.style.display = 'inline-block';
      btn.style.visibility = 'visible';
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      btn.click();
      return 'used: ' + songContainer.textContent.substring(0, 60);
    }
  }
})()\`)
```

### 关闭面板

**陷阱：点击面板外区域或ESC键可能误跳到其他页面。** 正确方式——点击mask层：

```js
// 找mask并点击
const mask = document.querySelector('[class*="mask"]');
mask.click();
```

或者直接点击关闭按钮（semi-sidesheet-close），坐标约 x:2305, y:24。

**陷阱：点击 mask 可能误跳到其他页面。** 实测中点击 mask-QlLmcw 后页面跳到了通知页 (`/creator-micro/message`)。安全方式：用 JS 执行 `document.querySelector('.semi-sidesheet-close').click()`，但如果 sidesheet 是 React 管理的，JS click 可能无效。最终需要用 CDP 鼠标点击关闭按钮的精确坐标。

### 发布后的验证

- 发布后跳转到 `creator.douyin.com/creator-micro/content/manage?enter_from=publish`
- 页面出现"发布成功"提示
- 作品列表中显示刚发布的视频，带有"审核中"状态

### 草稿恢复

如果页面意外跳转，回到上传页会有"你还有上次未发布的视频，是否继续编辑？"提示，点击"继续编辑"恢复所有内容（含已选的BGM）。

## 删除已发布视频

有时需要删除旧视频重新发布（如换BGM）。

**⚠️ 当前状态：删除流程尚未走通。** 多次尝试发现抖音创作者管理页的删除交互极其复杂（设置面板 + 多层弹窗 + 非 button 元素），耗时超过 20 次浏览器操作仍未成功删除。

**建议方案**：在抖音网页版手动删除（右键作品→删除→确定），比 browser automation 快得多。

**DOM 结构实测（2026-08-04）**：
- 页面：`creator.douyin.com/creator-micro/content/manage`
- 卡片结构：标题文本 → 5个 SVG 图标（编辑作品/设置权限/作品置顶/**删除作品**）
- "删除作品"是 `SPAN` 文本节点，父元素是 `div.ghost-btn-xUV8J0 op-btn-ILGveS`，不是 `<button>`
- 点击"删除作品"→ 打开**右侧设置面板**（不是确认弹窗）
- 设置面板底部有"取消"/"保存"两个 BUTTON
- 面板底部可能还有隐藏"删除作品"按钮，需滚动到底部
- 确认弹窗："确定要移除此作品吗" + "取消"/"确定"
- **关键陷阱**："确定"文本不是 `<button>` 元素，是其他 DOM 节点，`querySelector('button')` 找不到。需要通过"取消"按钮的兄弟节点定位

**已知坐标参考**（可能随版本变化）：
- 第一条视频的"删除作品"按钮约在 x=1797, y=245
- 右侧面板宽度约 421px，左侧边界 x=750
- 设置面板底部"取消"/"保存"约在 y=421

**陷阱：snapshotText() 中搜索 "Charlie" 可能找不到。** 标题被分段为"AI语音助手Charlie"，但 snapshotText 可能把 Charlie 和前面的文字分到不同节点。搜索"AI语音助手"更可靠。

## 图文发布（替代视频的质量问题）

**背景**：用户反馈 AI 生成的视频（文字幻灯片+TTS）质量差，要求改用图文格式。抖音图文发布流程如下。

### 已验证流程（2026-08-05 最新，含 click 静默失败修复）

1. 打开首页：`https://creator.douyin.com/creator-micro/home`
2. 点击"发布图文"区域（DIV 文本节点，不是 button）。用 JS 遍历找 `textContent.trim() === '发布图文'` 的叶子节点，向上找父 DIV 并 `.click()` → 跳转到 `/content/upload?default-tab=3`
3. **上传图片**：用 `DOM.querySelector` 取第一个 `input[type="file"]` 即可（2026-08-05 实测此页面变体只有一个 file input，图文模式下第一个就是图片 input）。如果 `setFileInputFiles` 后页面无反应，改用 `DOM.querySelectorAll` 取 `nodeIds[1]`（两个 input 的变体）
4. 上传 4 张图片 → 页面自动跳转到 `/content/post/image?enter_from=publish_page&media_type=image&type=new`
5. 填标题：`input[placeholder="添加作品标题"]`，用 native value setter
6. 填描述：`div[contenteditable=true]`，用 `execCommand('insertText')`（注意先 focus 到可见的 editor）
7. **点击"发布"按钮 — 两个坑**：
   - **坑 A**：`click('@ref')` 可能返回成功但 React 事件处理器不触发，页面不跳转。检测方法：click 后检查 `pageInfo().url` 是否变化
   - **坑 B**：如果 `click('@ref')` 静默失败，用 JS 直接 `document.querySelectorAll('button')` 找 `textContent.trim() === '发布'` 并 `.click()`
   ```js
   const result = await cdp('Runtime.evaluate', {
     expression: `(function() {
       const btns = document.querySelectorAll('button');
       for (const btn of btns) {
         if (btn.textContent?.trim() === '发布') { btn.click(); return 'clicked'; }
       }
       return 'not found';
     })()`
   })
   ```
8. 验证：URL 跳转到 `/content/manage?enter_from=publish`，页面显示"发布成功"

**历史记录（2026-08-04 首次跑通）**：当时上传页有两个 file input（video + image），需取 `nodeIds[1]`。2026-08-05 页面变体改为一个 file input，取第一个即可。两种情况都测试过，以实际 `document.querySelectorAll('input[type="file"]').length` 为准。

```js
// 获取图片 file input（不是视频的）
const doc = await cdp('DOM.getDocument', { depth: 0 })
const allInputs = await cdp('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' })
const imgInput = allInputs.nodeIds[1]  // 第二个是图片 input
await cdp('DOM.setFileInputFiles', {
  nodeId: imgInput,
  files: ['/tmp/dy_slide_0.png', '/tmp/dy_slide_1.png', '/tmp/dy_slide_2.png', '/tmp/dy_slide_3.png']
})
```

### 图片要求

- 格式：jpg、png、webp
- 画幅：3:4（竖版，推荐，适合信息流）
- 数量：每帖 2-9 张
- 风格：PIL 生成几何风格文字图，每页写一条优化

### 内容结构建议

4项优化合并为4张图：
1. 首图：标题图（"AI语音助手Charlie做了4项优化"）
2. 图2：大脑升级（火山引擎ARK）
3. 图3：全链路性能（首音频2.3s）
4. 图4：搜索能力 + 桌面封装

末尾简介加"由AI自主决策发布"

## 视频要求

- 格式：mp4、webm
- 时长：60分钟以内
- 大小：16G 以内
- 画幅：16:9、9:16、3:4、4:3、9:19.5（5.8寸）
- 超过40秒建议横版
