/**
 * web-ui/src/views/ActivityView.tsx —— 活动/回执视图（2026-10-21，9.3）。
 *
 * 数据源：GET /api/activity?limit=&status=（src/surfaces/http.ts）
 *   → { tasks: ActivityRow[], counts: [{status,n}], limit }
 *
 * 与 QueueView 的分工：
 *   QueueView   —— 「现在在途的怎么样」，按状态分栏，可取消。
 *   ActivityView —— 「已经发生的事各自结果如何」，按时间倒序，只读。
 *   两者数据源互补：/api/queue 只回非终态，/api/activity 的主体是终态。
 *
 * 为什么不订阅 SSE：活动是已经结束的事实，不会自己变。
 * 新的事实由用户主动刷新拿到 —— 这比给一个只读页接实时流更简单，也不会让人误以为在看直播。
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { api, type ActivityRow } from '../api.ts';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  running: '在跑',
  awaiting_approval: '待批',
  paused: '暂停',
  done: '完成',
  failed: '失败',
  cancelled: '取消',
};

/** created_at 存的是 epoch 毫秒字符串，也可能已经是 ISO；两种都吃，认不出就说不知道。 */
function fmtWhen(v: string | number): string {
  const n = typeof v === 'number' ? v : Number(v);
  const d = Number.isFinite(n) ? new Date(n) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '时间未知';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ActivityView(): JSX.Element {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [counts, setCounts] = useState<Array<{ status: string; n: number }>>([]);
  const [status, setStatus] = useState<string>('');
  const [limit, setLimit] = useState<number>(30);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await api.activity(limit, status === '' ? undefined : status);
      setRows(r.tasks);
      setCounts(r.counts);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [limit, status]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 总数按 n 降序，主人最关心的（通常是完成/失败）排在前面
  const totalParts = useMemo(
    () =>
      counts
        .slice()
        .sort((a, b) => b.n - a.n)
        .map((c) => `${STATUS_LABEL[c.status] ?? c.status} ${c.n}`),
    [counts],
  );

  return (
    <section className="view">
      <header className="view-head">
        <h1>活动</h1>
        <span className="muted">GET /api/activity · 只读 · 已结束的事实</span>
        <button type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? '…' : '刷新'}
        </button>
      </header>

      {err !== null && <p className="error">{err}</p>}

      <div className="activity-filters">
        <label>
          状态
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          条数
          <select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {[10, 30, 50, 100].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {totalParts.length > 0 && <span className="muted">全部任务：{totalParts.join(' · ')}</span>}
      </div>

      {rows.length === 0 && <p className="muted">{loading ? '读取中…' : '没有任务。'}</p>}

      <table className="activity-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>状态</th>
            <th>任务</th>
            <th>步数</th>
            <th>任务号</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.failedSteps > 0 ? 'has-failure' : undefined}>
              <td className="muted">{fmtWhen(t.createdAt)}</td>
              <td>
                <span className={`status status-${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
              </td>
              <td className="card-title">{t.title}</td>
              <td>
                {t.stepCount}
                {/* 失败步数只在真有时才显示 —— 每行都写「失败 0」等于噪音 */}
                {t.failedSteps > 0 && <span className="warn"> ⚠️ 失败 {t.failedSteps}</span>}
              </td>
              <td>
                <code title={t.id}>{t.id}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted">看单个任务的每一步：终端跑 `dotd task &lt;taskId&gt; --verbose`。</p>
    </section>
  );
}
