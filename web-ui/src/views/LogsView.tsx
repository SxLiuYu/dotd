/**
 * web-ui/src/views/LogsView.tsx —— 日志视图（bus log 通道的实时尾巴）。
 *
 * 数据源（与 sse.ts §4.5 逐条对齐）：
 *   SSE /api/stream?topics=log（bus.ts TOPICS 里归 'log' 通道的全部 topic：
 *      governance:quarantine / governance:quarantine_lifted / router.help_needed /
 *      router.recon_proposal / guard.level / stale_writer / exec.container.* /
 *      exec.browser.* / exec.disk.* / exec.docker.unavailable / event.received /
 *      config.models_reloaded）
 *   - 游标：EventSource 断线自动带 Last-Event-ID = bus_seq 重连；
 *   - 超出重放窗 → 服务端先发 event='resync'，此时只能提示"有丢弃"（log 无 REST 快照端点）。
 *
 * 说明：CP 的 daemon 自身日志（stdout）不经总线，不在此视图；此处只显示跨模块总线事件。
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { subscribeStream, type SseFrame } from '../api.ts';

interface LogLine {
  seq: number;
  topic: string;
  at: number;
  data: unknown;
}

const MAX_LINES = 500;

export function LogsView(): JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [state, setState] = useState('连接中…');
  const [dropped, setDropped] = useState(0);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    return subscribeStream(['log'], {
      onOpen: () => setState('已连接'),
      onError: () => setState('断线，重连中…'),
      onFrame: (f: SseFrame) => {
        if (f.event === 'resync') {
          // log 通道无 REST 快照可校正：诚实告知有帧被丢弃（不假装连续）
          setDropped((n) => n + 1);
          setState('已重连（超重放窗，中间有帧丢失）');
          return;
        }
        if (pausedRef.current) return;
        setLines((prev) => {
          const next = [...prev, { seq: f.seq, topic: f.event, at: Date.now(), data: f.data }];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      },
    });
  }, []);

  // 自动滚底（仅在未暂停时）
  useEffect(() => {
    if (paused) return;
    const el = boxRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const shown = filter.length === 0 ? lines : lines.filter((l) => l.topic.includes(filter));

  return (
    <section className="view">
      <header className="view-head">
        <h1>日志</h1>
        <span className="muted">
          SSE /api/stream?topics=log · 游标 bus_seq（Last-Event-ID 重连） · <em>{state}</em>
          {dropped > 0 && <b className="warn"> · 丢帧 {dropped}</b>}
        </span>
        <input
          className="filter"
          placeholder="按 topic 过滤（如 exec.call）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" onClick={() => setPaused((p) => !p)}>
          {paused ? '继续滚动' : '暂停滚动'}
        </button>
        <button type="button" onClick={() => setLines([])}>
          清空
        </button>
      </header>

      <div className="log-box" ref={boxRef}>
        {shown.length === 0 && <p className="muted">暂无日志帧。</p>}
        {shown.map((l, i) => (
          <div key={`${l.seq}-${i}`} className="log-line">
            <span className="muted">{new Date(l.at).toLocaleTimeString()}</span>
            <span className="seq">#{l.seq}</span>
            <code className="topic">{l.topic}</code>
            <span className="log-data">{typeof l.data === 'string' ? l.data : JSON.stringify(l.data)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
