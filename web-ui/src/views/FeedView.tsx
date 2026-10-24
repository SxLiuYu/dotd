/**
 * web-ui/src/views/FeedView.tsx —— 动态时间线（M1，2026-10-23）。
 *
 * 数据源：GET /api/feed?limit=100（src/surfaces/feed.ts 的只读投影）
 *   → { items: FeedItem[], generatedAt }
 *   GET /api/tasks/:id（点开某条任务时看一行摘要 / 步骤）
 *
 * 与 ActivityView 的分工：
 *   ActivityView —— 已经结束的任务各自结果如何（任务视角）。
 *   FeedView     —— 今天发生过什么、有什么在等你（时间线视角，含审批/事件/日程）。
 * 两者数据源不同，不互相替代。
 *
 * 这里不做 SSE：动态是只读快照，刷新即最新；接实时流会让人误以为在看直播。
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type FeedItem, type TaskBody } from '../api.ts';

const ATTENTION_LABEL: Record<FeedItem['attention'], string> = {
  high: '要你动手',
  normal: '进行中',
  low: '已结束',
};

function fmtAt(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

export function FeedView(): JSX.Element {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [highOnly, setHighOnly] = useState(false);
  const [selected, setSelected] = useState<TaskBody | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await api.feed(100);
      setItems(r.items);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openTask = async (id: string): Promise<void> => {
    setSelected(null);
    try {
      const body = await api.task(id);
      setSelected(body);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const submitGoal = async (goal: string): Promise<void> => {
    setBusy(true);
    setToast(null);
    try {
      const r = await api.send(goal);
      setToast(`已派任务 ${r.taskId}`);
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = highOnly ? items.filter((it) => it.attention === 'high') : items;

  return (
    <section className="view">
      <header className="view-head">
        <h1>动态</h1>
        <span className="muted">GET /api/feed · 只读时间线（任务 / 审批 / 事件 / 定时 / 日程）</span>
        <label className="muted">
          <input type="checkbox" checked={highOnly} onChange={(e) => setHighOnly(e.target.checked)} /> 只看要你动手
        </label>
        <button type="button" onClick={() => void reload()}>
          刷新
        </button>
      </header>

      {err !== null && <p className="error">{err}</p>}
      {toast !== null && <p className="toast">{toast}</p>}

      {shown.length === 0 && (
        <p className="muted">{items.length === 0 ? '动态是空的：没有在途任务、待批事项或今天的日程。' : '没有「要你动手」的条目。'}</p>
      )}

      <ul className="feed-list">
        {shown.map((it) => (
          <li key={it.id} className={`card feed-item attention-${it.attention}`}>
            <header>
              <span className={`badge badge-${it.attention}`}>{ATTENTION_LABEL[it.attention]}</span>
              <span className="muted">{fmtAt(it.at)}</span>
              <span className="muted feed-kind">{it.kind}</span>
              {it.action !== null && it.action.kind === 'open_task' && it.taskId !== null && (
                <button type="button" onClick={() => void openTask(it.taskId!)}>
                  {it.action.label}
                </button>
              )}
              {it.action !== null && it.action.kind === 'open_approval' && (
                <a className="button-link" href="#/approvals">
                  {it.action.label}
                </a>
              )}
              {it.action !== null && it.action.kind === 'submit_goal' && it.action.goal !== undefined && (
                <button type="button" disabled={busy} onClick={() => void submitGoal(it.action!.goal!)}>
                  {it.action.label}
                </button>
              )}
            </header>
            <p className="feed-title">{it.title}</p>
            {it.body !== null && it.body.length > 0 && <p className="muted">{it.body}</p>}
            <p className="muted feed-prov">
              来源 {it.provenance.source} · {it.provenance.ref}
              {it.provenance.note !== undefined ? ` · ${it.provenance.note}` : ''}
            </p>
          </li>
        ))}
      </ul>

      {selected !== null && (
        <div className="card feed-detail">
          <header>
            <b>{selected.task.title}</b>
            <span className="muted">{selected.task.id}</span>
            <button type="button" onClick={() => setSelected(null)}>
              关掉
            </button>
          </header>
          {selected.summary !== undefined ? (
            <>
              <p>{selected.summary.stateLine}</p>
              {selected.summary.next !== null && <p className="muted">下一步：{selected.summary.next}</p>}
              {selected.summary.progress !== null && (
                <p className="muted">计划进度：{selected.summary.progress.done}/{selected.summary.progress.total}</p>
              )}
            </>
          ) : (
            <p className="muted">这个任务没有摘要（可能还没开始跑）。</p>
          )}
          <p className="muted">
            状态 {selected.task.status} · 尝试 {selected.task.attempt} · 步骤 {selected.steps.length}
            {selected.summary?.elapsedMs != null ? ` · 已跑 ${fmtDuration(selected.summary.elapsedMs) ?? '未知'}` : ''}
          </p>
        </div>
      )}
    </section>
  );
}
