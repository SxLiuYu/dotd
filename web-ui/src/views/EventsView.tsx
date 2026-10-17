/**
 * web-ui/src/views/EventsView.tsx —— 事件视图。
 *
 * 数据源（与 http.ts:613-626 逐条对齐）：
 *   GET /api/events?limit=<n>（默认 100）→ { events, since }
 *   分页是 keyset：上一页最后一条的 receivedAt 作为下一次的 ?since=
 *   （服务端 SQL：`WHERE received_at < ? ORDER BY received_at DESC, id DESC LIMIT ?`）。
 *   无 SSE 通道（events 不在 BusChannel 六通道内）—— 靠"加载更多"翻页。
 */

import { Fragment, useCallback, useEffect, useState, type JSX } from 'react';
import { api, type EventRow } from '../api.ts';

const PAGE = 50;

function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

export function EventsView(): JSX.Element {
  const [rows, setRows] = useState<EventRow[]>([]);
  /** 下一页游标 = 本页最后一条的 receivedAt（服务端 `WHERE received_at < ?`）。 */
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async (cursor: number | null, append: boolean): Promise<void> => {
    setLoading(true);
    try {
      const r = await api.events(PAGE, cursor ?? undefined);
      setRows((prev) => (append ? [...prev, ...r.events] : r.events));
      const last = r.events.at(-1);
      setNextCursor(last === undefined ? null : last.receivedAt);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null, false);
  }, [load]);

  return (
    <section className="view">
      <header className="view-head">
        <h1>事件</h1>
        <span className="muted">
          GET /api/events?since=（keyset 分页，received_at 排序） · 每页 {PAGE}
        </span>
        <button type="button" disabled={loading} onClick={() => void load(null, false)}>
          重新加载
        </button>
      </header>

      {err !== null && <p className="error">{err}</p>}

      <table className="events-table">
        <thead>
          <tr>
            <th>#</th>
            <th>时间</th>
            <th>来源</th>
            <th>状态</th>
            <th>摘要</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <Fragment key={e.id}>
              <tr className="clickable" onClick={() => setOpenId((cur) => (cur === e.id ? null : e.id))}>
                <td>{e.id}</td>
                <td>{new Date(e.receivedAt).toLocaleString()}</td>
                <td>
                  <code>{e.source}</code>
                  <span className="muted"> {e.actor ?? ''}</span>
                </td>
                <td>
                  <span className={`pill st-${e.status}`}>{e.status}</span>
                </td>
                <td className="mono">{e.dedupKey}</td>
              </tr>
              {openId === e.id && (
                <tr>
                  <td colSpan={5}>
                    <pre>{prettyPayload(e.payload)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {rows.length === 0 && !loading && <p className="muted">暂无事件。</p>}
      <button
        type="button"
        className="more"
        disabled={loading || nextCursor === null}
        onClick={() => void load(nextCursor, true)}
      >
        {loading ? '加载中…' : nextCursor === null ? '没有更多了' : '加载更多'}
      </button>
    </section>
  );
}
