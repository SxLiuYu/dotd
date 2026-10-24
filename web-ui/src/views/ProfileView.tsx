/**
 * web-ui/src/views/ProfileView.tsx —— 人格（M3，2026-10-23）。
 *
 * 数据源：GET /api/memory/identity → { path, text, exists, limitBytes }
 *         PUT /api/memory/identity { text } → { ok, warning?, path, limitBytes }
 *
 * 为什么不做成"名字/头像/声音"的表单：
 *   Muse 的人格是角色定制；dotd 的差异应该是**人格是一个你能读、能改、能回滚的文件**。
 *   所以这里就是一个 textarea 对着 /dot/home/IDENTITY.md，写什么就是什么，
 *   跟着 home 卷一起备份，不藏进数据库。
 */

import { useEffect, useState, type JSX } from 'react';
import { api } from '../api.ts';

const PLACEHOLDER = `# 我是谁 / 怎么跟你说话
名字：Dot
称呼：叫主人「老张」
语气：简短、直接，先给结论
边界：不确定的事先说不确定，不替我拍板花钱`;

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function ProfileView(): JSX.Element {
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(1024);
  const [path, setPath] = useState('IDENTITY.md');
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .identity()
      .then((r) => {
        if (!alive) return;
        setText(r.text);
        setLimit(r.limitBytes);
        setPath(r.path);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setToast(null);
    try {
      const r = await api.saveIdentity(text);
      if (r.ok) setToast(`已写入 ${r.path}`);
      else setErr(r.warning ?? '写入失败');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const used = bytesOf(text);
  const over = used > limit;

  return (
    <section className="view">
      <header className="view-head">
        <h1>人格</h1>
        <span className="muted">
          {path} · {used}/{limit} 字节 · 每次任务开始时注入
        </span>
        <button type="button" disabled={busy || over} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </header>

      <p className="muted">
        写「它该怎么跟你说话」：名字、称呼、语气、边界。不写「关于你的事实」——那些放记忆里。
        空着也没关系，空文件不会改变任何行为。
      </p>

      {err !== null && <p className="error">{err}</p>}
      {toast !== null && <p className="toast">{toast}</p>}

      <textarea
        className="identity-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={16}
        spellCheck={false}
      />
      {over && <p className="error">超出 {used - limit} 字节：删掉一些再保存。</p>}
    </section>
  );
}
