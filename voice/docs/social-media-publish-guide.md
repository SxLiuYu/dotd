# 社交媒体发布完整流程

> 2026-08-12 更新：已废弃 Playwright / ego-browser 自动化发布（小红书封号风险）。
> 当前模式：AI 生成封面图 + 文案，用户手动在创作者后台发布。
> 下方保留 ego-browser 脚本作为参考归档。

## 一、前置条件

### 1. 图片素材
```bash
# 用 PIL 生成封面图（1080×1440, 3:4 竖版）
python3 skills/templates/cover_geometric.py
# 输出: /tmp/xhs_cover.png（小红书封面）, /tmp/dy_slide_0~3.png（抖音幻灯片）
```

### 2. 文案
- 标题：≤20 字（如 `AI语音助手Charlie`）
- 描述/正文：极简风格，4-6 行短句，不加分段说明
- ⚠️ **禁止加「由AI自主决策发布」等 AI 披露文字**（小红书会封号）

### 3. 飞书配置
```
FEISHU_APP_ID=cli_a90c00e983395bc4
FEISHU_APP_SECRET=xxx
FEISHU_PUSH_OPEN_ID=ou_xxx
```

---

## 二、抖音图文发布

### 方案 A：ego-browser（推荐）

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('ego-publish')
await openOrReuseTab('https://creator.douyin.com/creator-micro/content/upload?default-tab=3', { wait: true, timeout: 20 })

// 等待 file input 出现
for (let i = 0; i < 20; i++) {
    await wait(2)
    const doc = await cdp('DOM.getDocument', { depth: 0 })
    const q = await cdp('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' })
    if (q.nodeIds.length > 0) {
        // 上传图片（用最后一个 input）
        await cdp('DOM.setFileInputFiles', { nodeId: q.nodeIds[q.nodeIds.length-1],
            files: ['/tmp/dy_slide_0.png','/tmp/dy_slide_1.png','/tmp/dy_slide_2.png','/tmp/dy_slide_3.png'] })
        break
    }
}

await wait(8)  // 等待跳转到编辑页

// 填标题（nativeInputValueSetter 触发 React）
await cdp('Runtime.evaluate', { expression: `(function(){
    const i=document.querySelector('input[placeholder="添加作品标题"]');
    if(i){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(i,'AI语音助手Charlie');i.dispatchEvent(new Event('input',{bubbles:true}))}
})()` })

// 填描述（innerHTML）
await cdp('Runtime.evaluate', { expression: `(function(){
    const e=document.querySelector('div[contenteditable=true]');
    if(e){e.focus();e.innerHTML='描述内容';e.dispatchEvent(new Event('input',{bubbles:true}))}
})()` })

// 隐藏弹窗 + 点发布
await cdp('Runtime.evaluate', { expression: `document.querySelectorAll('[role=dialog]').forEach(d=>d.style.display='none')` })
await cdp('Runtime.evaluate', { expression: `(function(){
    const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.trim()==='发布'&&b.offsetParent!==null);
    if(b){b.scrollIntoView();b.click()}
})()` })

await wait(6)
const u = (await pageInfo()).url
cliLog(u.includes('manage') ? 'PUBLISH_OK' : 'RETRY')
EOF
```

### 关键点
| 步骤 | 正确做法 | 错误做法 |
|------|---------|---------|
| 上传页 URL | `/content/upload?default-tab=3` | ❌ `/content/post/image`（没有 file input）|
| file input | `nodeIds[nodeIds.length-1]`（取最后一个） | ❌ 第一个可能是视频 input |
| 标题填写 | `nativeInputValueSetter` + dispatch input 事件 | ❌ `Input.insertText`（会卡死）|
| 发布按钮 | JS `button.click()` + `scrollIntoView` | ❌ `click('@ref')`（React 可能不响应）|
| 验证成功 | URL 跳转到 `content/manage?enter_from=publish` | — |
| 重试 | 隐藏弹窗后再点一次发布 | — |

---

## 三、小红书发布

### 方案 A：ego-browser

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('ego-publish')
await openOrReuseTab('https://creator.xiaohongshu.com/publish/publish?target=image', { wait: true, timeout: 20 })

// 上传封面（Playwright set_input_files 触发 React onChange）
// ego 里用 CDP setFileInputFiles
const doc = await cdp('DOM.getDocument', { depth: 0 })
const q = await cdp('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' })
await cdp('DOM.setFileInputFiles', { nodeId: q.nodeIds[0], files: ['/tmp/xhs_cover.png'] })

// 等待编辑页加载（标题输入框出现）
for (let i = 0; i < 15; i++) {
    await wait(2)
    const has = await cdp('Runtime.evaluate', { expression: `!!document.querySelector('input[placeholder="填写标题会有更多赞哦"]')` })
    if (has.result?.value) break
}

// ⚠️ 等待图片上传到 CDN（blob: → xhscdn.com，不等待会存草稿！）
for (let i = 0; i < 15; i++) {
    await wait(2)
    const status = await cdp('Runtime.evaluate', { expression: `(function(){
        const imgs=document.querySelectorAll('img');
        for(const img of imgs){if(img.src.startsWith('blob:'))return'blob';
        if(img.src.includes('xhscdn')||img.src.includes('sns-img'))return'cdn'}
        return'none'
    })()` })
    if (status.result?.value === 'cdn') break
}

// 删除遮罩层（hover-mask 会拦截点击！）
await cdp('Runtime.evaluate', { expression: `document.querySelectorAll('[class*="mask"],[class*="overlay"]').forEach(e=>e.remove())` })

// 填标题
await cdp('Runtime.evaluate', { expression: `(function(){
    const i=document.querySelector('input[placeholder="填写标题会有更多赞哦"]');
    if(i){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(i,'AI语音助手Charlie');i.dispatchEvent(new Event('input',{bubbles:true}))}
})()` })

// 填正文
await cdp('Runtime.evaluate', { expression: `(function(){
    const eds=document.querySelectorAll('[contenteditable=true]');
    for(const ed of eds){if(ed.offsetParent!==null){ed.focus();break}}
    document.execCommand('insertText',false,'正文内容')
})()` })

// 滚动 + shadow DOM piercing 点击发布
await cdp('Runtime.evaluate', { expression: `document.querySelector('xhs-publish-btn')?.scrollIntoView({block:'center'})` })

const doc2 = await cdp('DOM.getDocument', { depth: -1, pierce: true })
// 递归搜索 shadow DOM 内 button.ce-btn.bg-red
function findBtn(node) {
    if (node.nodeName === 'BUTTON') {
        const attrs = node.attributes || []
        const cls = (attrs[attrs.indexOf('class')+1] || '')
        if (cls.includes('bg-red')) return node
    }
    for (const c of node.children || []) { const r = findBtn(c); if (r) return r }
    for (const sr of node.shadowRoots || []) { const r = findBtn(sr); if (r) return r }
    return null
}
const btn = findBtn(doc2.root)
const resolved = await cdp('DOM.resolveNode', { nodeId: btn.nodeId })
await cdp('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    functionDeclaration: "function(){this.click();return'clicked'}",
    returnByValue: true
})

// ⚠️ 验证：拦截 API 响应，不是看 URL 跳转！
// POST https://edith.xiaohongshu.com/web_api/sns/v2/note 返回 {success:true} 即成功
EOF
```

### 关键点
| 步骤 | 正确做法 | 错误做法 |
|------|---------|---------|
| 上传封面 | CDP `DOM.setFileInputFiles` | — |
| 等待 CDN | blob: → xhscdn.com，**必须等待** | ❌ 不等待就点发布会存草稿 |
| 删遮罩 | `removeOverlays()` 删 mask/overlay | ❌ 遮罩会拦截发布按钮点击 |
| 填标题 | `nativeInputValueSetter` | ❌ `Input.insertText`（卡死）|
| 填正文 | `execCommand('insertText')` | ❌ `innerHTML`（可能不触发 Vue）|
| 发布按钮 | CDP `pierce:true` + `DOM.resolveNode` + `callFunctionOn(this.click())` | ❌ 普通 `button.click()`（closed shadow DOM 不可访问）|
| 验证成功 | 拦截 `POST /web_api/sns/v2/note` 响应看 `success:true` | ❌ URL 不一定跳 `success` 页 |

---

## 四、登录流程

### ego-browser 登录（二维码扫码）

ego task space 不继承 Chrome profile 的 cookie，需要每次登录。流程：

1. **打开登录页** + **截图二维码** + **发飞书通知**
2. **用户在 ego-lite 浏览器窗口扫码**（或在飞书看到截图后扫码）
3. **轮询 `snapshotText()`** 直到不含"扫码登录"
4. 登录态在当前 task space 内有效

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('ego-publish')
await openOrReuseTab('https://creator.douyin.com/creator-micro/home', { wait: true, timeout: 20 })
await wait(5)

// 发飞书通知用户去浏览器窗口扫码
const tr = await serverFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({app_id: 'cli_a90c00e983395bc4', app_secret: 'YOUR_FEISHU_APP_SECRET_HERE'})
})
const token = JSON.parse(tr).tenant_access_token
await serverFetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: 'ou_ffd590a1fc7f566daba4d7f69d152f97', msg_type: 'text',
        content: JSON.stringify({text: '🔑 请在 ego-lite 浏览器窗口扫码登录'}) })
})

// 轮询等待
for (let i = 0; i < 200; i++) {
    await wait(3)
    const body = await snapshotText()
    if (!body.includes('扫码登录')) { cliLog('LOGIN_OK'); break }
    if (i % 10 === 0) cliLog('waiting... ' + (i*3) + 's')
}
EOF
```

### ⚠️ ego task space 注意事项
- **每次 `ego-browser nodejs` 调用是无状态的**——新进程连接上去但页面可能已刷新
- **登录态在 task space 内有效**，但如果页面被重新加载可能丢失
- **始终用同一个 task space 名称**（如 `ego-publish`），不要每次换名称
- **前台执行**能看到输出，后台执行需要 `| tee /tmp/xxx.log` 才能捕获输出

---

## 五、标准化动作库

`charlie/browser_actions.py` 提供了标准化动作：

### 基础动作
```python
from browser_actions import BrowserSession

session = BrowserSession(headless=False)
session.start()

session.navigate("https://...")
session.upload_files('input[type="file"]', ['/tmp/img.png'])
session.fill_input('input[placeholder="标题"]', '标题文字')
session.fill_editor('正文内容')
session.click_button("发布")
session.click_shadow_dom_button("bg-red")  # shadow DOM 发布按钮
session.remove_overlays()  # 删遮罩
session.wait_for_image_cdn()  # 等图片上传到 CDN
session.hide_dialogs()
session.wait_for_url("manage")  # 等 URL 跳转验证
```

### 复合动作
```python
from browser_actions import publish_douyin, publish_xiaohongshu

# 抖音
publish_douyin(session, slides=['/tmp/dy_slide_0.png', ...], title="标题", content="描述")

# 小红书
publish_xiaohongshu(session, cover="/tmp/xhs_cover.png", title="标题", content="正文")
```

### 飞书集成
```python
from browser_actions import send_feishu_image, send_feishu_text

send_feishu_image("/tmp/qr.png", caption="请扫码登录")
send_feishu_text("✅ 发布成功！")
```

---

## 六、踩坑记录

| # | 平台 | 问题 | 原因 | 解决 |
|---|------|------|------|------|
| 1 | 小红书 | 封号 | 内容标注「由AI自主决策发布」 | **禁止任何 AI 披露文字** |
| 2 | 小红书 | 发布存草稿 | 图片未上传到 CDN 就点发布 | 等 blob: → xhscdn.com |
| 3 | 小红书 | 发布按钮点不动 | hover-mask 遮罩拦截点击 | 先 `removeOverlays()` |
| 4 | 小红书 | 找不到发布按钮 | `<xhs-publish-btn>` 是 closed shadow DOM | CDP `pierce:true` + `resolveNode` + `callFunctionOn` |
| 5 | 小红书 | URL 不跳 success | 页面不一定跳转 | 拦截 `POST /web_api/sns/v2/note` 看 `success:true` |
| 6 | 抖音 | file input: 0 | 用了 `/content/post/image` 而非 `/content/upload` | 用 `/content/upload?default-tab=3` |
| 7 | 抖音 | 发布按钮不响应 | React 合成事件 | JS `button.click()` + `scrollIntoView` |
| 8 | 抖音 | 需要重试一次 | 弹窗遮挡 | 隐藏弹窗后再点一次 |
| 9 | ego | task space 越开越多 | 每次用不同名称 | 始终用 `ego-publish` |
| 10 | ego | 后台不输出 | heredoc + 后台不兼容 | 用 `| tee /tmp/xxx.log` |
