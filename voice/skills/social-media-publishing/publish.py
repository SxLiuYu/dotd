"""
Charlie 项目 - 社交媒体发布工具
用法: python3 publish.py --platform xhs|dy --images /tmp/img*.png
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

def get_cookies():
    """从Chrome读取小红书和抖音cookie"""
    import sqlite3, shutil
    from pathlib import Path
    tmp = Path("/tmp/chrome_cookies.db")
    try:
        shutil.copy2(Path.home() / "Library/Application Support/Google/Chrome/Default/Cookies", tmp)
        conn = sqlite3.connect(str(tmp))
        cursor = conn.cursor()
        cookies = {}
        for domain in ['.xiaohongshu.com', '.douyin.com']:
            cursor.execute("SELECT name, value FROM cookies WHERE host_key LIKE ?", (f'%{domain}',))
            rows = cursor.fetchall()
            if rows:
                cookies[domain] = {r[0]: r[1][:100] for r in rows}
        conn.close()
        tmp.unlink(missing_ok=True)
        return cookies
    except Exception as e:
        print(f"读取cookies失败: {e}")
        return {}

def publish_xhs(cover_path: str, title: str, content: str):
    """通过ego-browser发布小红书（需要手动操作发布按钮）"""
    script = f'''
const task = await useOrCreateTaskSpace('charlie-xhs-publish')
await openOrReuseTab('https://creator.xiaohongshu.com/publish/publish?target=image', {{ wait: true, timeout: 30 }})
await wait(8)
const doc = await cdp('DOM.getDocument', {{ depth: 0 }})
const q = await cdp('DOM.querySelector', {{ nodeId: doc.root.nodeId, selector: 'input[type="file"]' }})
await cdp('DOM.setFileInputFiles', {{ nodeId: q.nodeId, files: ['{cover_path}'] }})
await wait(8)
await cdp('Runtime.evaluate', {{ expression: `{{
  const inp = document.querySelector('input[placeholder="填写标题会有更多赞哦"]')
  if(inp){{
    inp.focus()
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
    s.call(inp, '{title.replace(chr(39), chr(92)+chr(39))}')
    inp.dispatchEvent(new Event('input',{{bubbles:true}}))
  }}
}}` }})
await wait(1)
await cdp('Runtime.evaluate', {{ expression: `{{
  const body = {json.dumps(content)}
  const editors = document.querySelectorAll('[contenteditable=true]')
  for(const ed of editors){{
    if(ed.offsetParent !== null){{ ed.focus(); break }}
  }}
  document.execCommand('insertText', false, body)
}}` }})
await wait(2)
await scrollBy(800)
await wait(2)
const ax = await cdp('Accessibility.getFullAXTree')
let btnId = null
for(const n of ax.nodes || []){{
  const nm = (n.name || {{}}).value || ''
  const rl = n.role || ''
  if(nm === '发布' && rl === 'button') btnId = n.backendDOMNodeId
}}
if(btnId){{
  const resolved = await cdp('DOM.resolveNode', {{ backendNodeId: btnId }})
  await cdp('Runtime.callFunctionOn', {{
    objectId: resolved.object.objectId,
    functionDeclaration: "function(){{this.click();return'ok'}}",
    returnByValue: true
  }})
  await wait(10)
  const info = await pageInfo()
  cliLog('URL: ' + info.url)
  cliLog(info.url.includes('success') ? '✅ 发布成功!' : '⚠️ 发布状态待确认')
}} else {{
  cliLog('发布按钮未找到')
}}
'''
    result = subprocess.run(
        ['ego-browser', 'nodejs'],
        input=script,
        capture_output=True,
        text=True,
        timeout=120
    )
    print(result.stdout[-2000:])
    if result.stderr:
        print(f"STDERR: {result.stderr[-500:]}", file=sys.stderr)
    return result.returncode == 0

def publish_dy(slides: list[str], title: str, content: str):
    """通过ego-browser发布抖音图文"""
    imgs_arg = ','.join(f'"{p}"' for p in slides)
    script = f'''
const task = await useOrCreateTaskSpace('charlie-dy-publish')
await openOrReuseTab('https://creator.douyin.com/creator-micro/content/post/image?media_type=image', {{ wait: true, timeout: 30 }})
await wait(8)
const doc = await cdp('DOM.getDocument', {{ depth: 0 }})
const all = await cdp('DOM.querySelectorAll', {{ nodeId: doc.root.nodeId, selector: 'input[type="file"]' }})
const imgId = all.nodeIds.length >= 2 ? all.nodeIds[1] : all.nodeIds[0]
await cdp('DOM.setFileInputFiles', {{ nodeId: imgId, files: [{imgs_arg}] }})
await wait(8)
await cdp('Runtime.evaluate', {{ expression: `{{
  const inp = document.querySelector('input[placeholder="添加作品标题"]')
  if(inp){{
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
    s.call(inp, '{title.replace(chr(39), chr(92)+chr(39))}')
    inp.dispatchEvent(new Event('input',{{bubbles:true}}))
  }}
}}` }})
await wait(1)
await cdp('Runtime.evaluate', {{ expression: `{{
  const body = {json.dumps(content)}
  const ces = document.querySelectorAll('[contenteditable=true]')
  for(const ce of ces){{ if(ce.offsetParent !== null){{ ce.focus(); break }} }}
  document.execCommand('insertText', false, body)
}}` }})
await wait(2)
for(let i=0;i<5;i++){{ await scrollBy(400); await wait(0.5) }}
const r = await cdp('Runtime.evaluate', {{ expression: `{{
  const btns = document.querySelectorAll('button')
  for(const btn of btns){{
    if(btn.textContent?.trim()==='发布' && btn.offsetParent !== null){{
      btn.click()
      return 'clicked'
    }}
  }}
  return 'not found'
}}` }})
cliLog('发布点击: ' + r.result.value)
await wait(8)
const url = await cdp('Runtime.evaluate', {{ expression: 'location.href' }})
cliLog('URL: ' + url.result.value)
if(url.result.value?.includes('manage')) cliLog('✅ 抖音发布成功!')
'''
    result = subprocess.run(
        ['ego-browser', 'nodejs'],
        input=script,
        capture_output=True,
        text=True,
        timeout=120
    )
    print(result.stdout[-2000:])
    if result.stderr:
        print(f"STDERR: {result.stderr[-500:]}", file=sys.stderr)
    return result.returncode == 0

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', choices=['xhs', 'dy'], required=True)
    parser.add_argument('--images', nargs='+', required=True)
    parser.add_argument('--title', default='AI语音助手Charlie')
    parser.add_argument('--content', default='')
    args = parser.parse_args()
    
    if args.platform == 'xhs':
        publish_xhs(args.images[0], args.title, args.content)
    else:
        publish_dy(args.images, args.title, args.content)
