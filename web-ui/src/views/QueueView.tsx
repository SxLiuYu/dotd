/**
 * web-ui/src/views/QueueView.tsx —— 队列视图。
 *
 * 数据源（与 http.ts 逐条对齐）：
 *   GET /api/queue?status=<csv>（http.ts:508-527）→ { queue: [{id,title,status,priority,dotId,updatedAt}] }
 *      服务端默认只回 queued,running；本视图显式拉全态自己做分栏。
 *   POST /api/queue/:id/cancel（http.ts:529-537）→ { ok, taskId }；失败 404 { error:'cancel_failed' }
 *   流：SSE /api/stream?topics=queue（§4.5；resync 时重拉快照）
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, subscribeStream, type QueueRow, type SseFrame } from '../api.ts';

const ALL = ['queued', 'running', 'awaiting_approval', 'paused', 'done', 'failed', 'cancelled'].join(',');

const COLUMNS: Array<{ key: QueueRow['status']; label: string }> = [
  { key: 'queued', label: '排队' },
  { key: 'running', label: '在跑' },
  { key: 'awaiting_approval', label: '待批' },
  { key: 'paused', label: '暂停' },
  { key: 'done', label: '完成' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '取消' },
];

export function QueueView(): JSX.Element {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await api.queue(ALL);
      setRows(r.queue);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // SSE：queue 通道任一回帧都重拉（帧体积小，全量重读比分片 diff 简单且不会漏）
  useEffect(() => {
    return subscribeStream(['queue'], {
      onFrame: (f: SseFrame) => {
        if (f.event === 'resync') void reload();
      },
    });
  }, [reload]);

  const cancel = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await api.cancelTask(id);
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="view">
      <header className="view-head">
        <h1>队列</h1>
        <span className="muted">
          GET /api/queue · POST /api/queue/:id/cancel · SSE topics=queue
        </span>
        <button type="button" onClick={() => void reload()}>
          刷新
        </button>
      </header>

      {err !== null && <p className="error">{err}</p>}

      <div className="queue-grid">
        {COLUMNS.map((col) => {
          const items = rows.filter((r) => r.status === col.key);
          return (
            <div key={col.key} className="queue-col">
              <h2>
                {col.label} <span className="muted">{items.length}</span>
              </h2>
              {items.length === 0 && <p className="muted">空</p>}
              {items.map((t) => (
                <article key={t.id} className={`card prio-${Math.min(t.priority, 9)}`}>
                  <header>
                    <code title={t.id}>{t.id.length > 14 ? `${t.id.slice(0, 14)}…` : t.id}</code>
                    <span className="muted">p{t.priority}</span>
                  </header>
                  <p className="card-title">{t.title}</p>
                  <footer>
                    <span className="muted">{t.dotId}</span>
                    <span className="muted">{new Date(t.updatedAt).toLocaleTimeString()}</span>
                    {['queued', 'running', 'awaiting_approval', 'paused'].includes(t.status) && (
                      <button type="button" disabled={busyId === t.id} onClick={() => void cancel(t.id)}>
                        {busyId === t.id ? '…' : '取消'}
                      </button>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
