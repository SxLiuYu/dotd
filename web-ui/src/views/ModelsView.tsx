/**
 * web-ui/src/views/ModelsView.tsx —— 模型视图（MR snapshot 的只读投影）。
 *
 * 数据源（与 http.ts:637-651 逐条对齐）：
 *   GET /api/models/rank（http.ts:646-659）→ { mode, rank:[{id,tier,emergencyEligible,
 *      roles:{primary:{breaker},light:{breaker}}}], pool, pendingRecon }
 *   GET /api/breaker（http.ts:643-645）→ { snapshot: RouterSnapshot }
 *      （契约形状 shared/contracts.ts:443-465；MR 是唯一属主，UI 不直连库）
 *   流：SSE /api/stream?topics=breaker（§4.5；resync 时重拉）
 *
 * 本视图只读。端点增删/探测/模式切换归 MR 自己的治理回路（评审 #10），UI 不触发。
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, subscribeStream, type EndpointRankRow, type SseFrame } from '../api.ts';

interface Snapshot {
  mode: string;
  emergencyActive: boolean;
  endpoints: Array<{
    id: string;
    tier: number;
    emergencyEligible: boolean;
    roles: Record<string, { breaker: string; consecFailures: number; nextProbeAt: number | null; throttledUntil: number | null; lastKind: string | null }>;
  }>;
  pool: Array<{ id: string; lastVerifiedAt: number | null; qualifiedForPrimary: boolean }>;
  pendingRecon: number;
  openAlerts: number;
  lastAlert: { signature: string; sentAt: number; channel: string } | null;
}

function fmtAt(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleTimeString();
}

export function ModelsView(): JSX.Element {
  const [rank, setRank] = useState<EndpointRankRow[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [r, b] = await Promise.all([api.models(), api.breaker()]);
      setRank(r.rank);
      setSnap(b.snapshot as Snapshot);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return subscribeStream(['breaker'], {
      onFrame: (f: SseFrame) => {
        if (f.event === 'resync') void reload();
      },
    });
  }, [reload]);

  return (
    <section className="view">
      <header className="view-head">
        <h1>模型</h1>
        <span className="muted">
          GET /api/models/rank · /api/breaker → ModelRouter.snapshot() · SSE topics=breaker
        </span>
        <button type="button" onClick={() => void reload()}>
          刷新
        </button>
      </header>

      {err !== null && <p className="error">{err}</p>}

      {snap !== null && (
        <div className="stat-row">
          <div className="stat">
            <span className="muted">模式</span>
            <b>{snap.mode}</b>
          </div>
          <div className="stat">
            <span className="muted">紧急态</span>
            <b className={snap.emergencyActive ? 'danger' : ''}>{snap.emergencyActive ? 'ACTIVE' : 'off'}</b>
          </div>
          <div className="stat">
            <span className="muted">待侦察</span>
            <b>{snap.pendingRecon}</b>
          </div>
          <div className="stat">
            <span className="muted">未消告警</span>
            <b>{snap.openAlerts}</b>
          </div>
          {snap.lastAlert !== null && (
            <div className="stat">
              <span className="muted">最近告警</span>
              <b title={snap.lastAlert.signature}>
                {new Date(snap.lastAlert.sentAt).toLocaleTimeString()} · {snap.lastAlert.channel}
              </b>
            </div>
          )}
        </div>
      )}

      <table className="events-table">
        <thead>
          <tr>
            <th>端点</th>
            <th>tier</th>
            <th>紧急准入</th>
            <th>primary 熔断</th>
            <th>light 熔断</th>
            <th>下次探测</th>
          </tr>
        </thead>
        <tbody>
          {(snap?.endpoints ?? []).map((ep) => (
            <tr key={ep.id}>
              <td>
                <code>{ep.id}</code>
              </td>
              <td>{ep.tier}</td>
              <td>{ep.emergencyEligible ? '是' : '否'}</td>
              <td>
                <span className={`pill bk-${ep.roles.primary?.breaker ?? 'closed'}`}>{ep.roles.primary?.breaker ?? '—'}</span>
                {(ep.roles.primary?.consecFailures ?? 0) > 0 && (
                  <span className="muted"> 连败 {ep.roles.primary?.consecFailures}</span>
                )}
              </td>
              <td>
                <span className={`pill bk-${ep.roles.light?.breaker ?? 'closed'}`}>{ep.roles.light?.breaker ?? '—'}</span>
              </td>
              <td className="muted">
                {fmtAt(ep.roles.primary?.nextProbeAt ?? null)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rank.length > 0 && (
        <>
          <h2>排序（/api/models/rank）</h2>
          <ol className="rank-list">
            {rank.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> <span className="muted">tier {r.tier}</span>
                {Object.entries(r.roles).map(([track, state]) => (
                  <span key={track} className={`pill bk-${String(state)}`}>
                    {track}: {String(state)}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
