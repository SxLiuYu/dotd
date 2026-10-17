/**
 * web-ui/src/views/ApprovalsView.tsx —— 审批视图。
 *
 * 数据源（与 http.ts 逐条对齐）：
 *   GET /api/approvals?state=pending（http.ts:557-565）→ { approvals: ApprovalView[] }
 *      （契约形状见 shared/contracts.ts:564-578；SF 只读投影，属主是 GOV）
 *   POST /api/approvals/:id/decision（http.ts:587-610）
 *      body { verdict:'approve_once'|'approve_remember'|'reject', note?, channel:'web' }
 *      回 200 { ok:true } 或 409 { ok:false, finalStatus, reason }（late 裁决原样转 toast）
 *   流：SSE /api/stream?topics=approval（§4.5）
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, subscribeStream, type ApprovalRow, type SseFrame, type Verdict } from '../api.ts';

const VERDICTS: Array<{ v: Verdict; label: string; cls: string }> = [
  { v: 'approve_once', label: '放行一次', cls: 'ok' },
  { v: 'approve_remember', label: '放行并记住', cls: 'ok' },
  { v: 'reject', label: '拒绝', cls: 'danger' },
];

function briefText(a: ApprovalRow): string | null {
  const b = a.riskBrief;
  if (b === undefined) return null;
  const parts: string[] = [];
  if (typeof b.verdict === 'string') parts.push(`预检 ${b.verdict}`);
  if (typeof b.reason === 'string') parts.push(b.reason);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function ApprovalsView(): JSX.Element {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await api.approvals();
      setRows(r.approvals);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return subscribeStream(['approval'], {
      onFrame: (f: SseFrame) => {
        if (f.event === 'resync') void reload();
      },
    });
  }, [reload]);

  const decide = async (id: number, verdict: Verdict): Promise<void> => {
    setBusyId(id);
    setToast(null);
    try {
      const r = await api.decide(id, verdict);
      setToast(
        r.ok
          ? `#${id} 已${verdict === 'reject' ? '拒绝' : '放行'} → ${r.finalStatus}`
          : `#${id} 迟到：${r.finalStatus}${r.reason !== undefined ? `（${r.reason}）` : ''}`,
      );
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
        <h1>审批</h1>
        <span className="muted">
          GET /api/approvals?state=pending · POST /api/approvals/:id/decision · SSE topics=approval
        </span>
        <button type="button" onClick={() => void reload()}>
          刷新
        </button>
      </header>

      {err !== null && <p className="error">{err}</p>}
      {toast !== null && <p className="toast">{toast}</p>}

      {rows.length === 0 && <p className="muted">没有待批项。</p>}

      <ul className="approval-list">
        {rows.map((a) => {
          const brief = briefText(a);
          return (
            <li key={a.id} className="card">
              <header>
                <span className="seq">#{a.seq}</span>
                <code>{a.kind}</code>
                {a.tier !== null && <span className="tier">{a.tier}</span>}
                <span className="muted">任务 <code>{a.taskRef.taskId}</code></span>
              </header>
              <p className="card-title">{a.summary}</p>
              {a.reason.length > 0 && <p className="muted">理由：{a.reason}</p>}
              {brief !== null && <p className="warn">{brief}</p>}
              <p className="muted">
                过期 {new Date(a.expiresAt).toLocaleString()} · journal step <code>{a.taskRef.journalStepId}</code>
              </p>
              <details>
                <summary>全量参数</summary>
                <pre>{JSON.stringify(a.fullParams, null, 2)}</pre>
              </details>
              <footer>
                {VERDICTS.map((x) => (
                  <button
                    key={x.v}
                    type="button"
                    className={x.cls}
                    disabled={busyId === a.id}
                    onClick={() => void decide(a.id, x.v)}
                  >
                    {x.label}
                  </button>
                ))}
              </footer>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
