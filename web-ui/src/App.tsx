import { useEffect, useState } from 'react';
import { VIEWS, sourceOf } from './views.tsx';
import { api, getToken, setToken, type StatusBody } from './api.ts';

/**
 * web-ui/src/App.tsx —— 外壳（左栏导航 + 顶栏身份/状态 + 右侧六视图）。
 *
 * SF §7 的完整页面集含 Breaker 与 Settings；本版落地任务书要求的六个主视图：
 * Chat / Queue / Approvals / Events / Models / Logs。Breaker 数据在 Models 视图内
 * 一并展示（GET /api/breaker），Settings 暂无后端（hooks 在线编辑 = 阶段二，
 * http.ts:667-673 明确 501）。
 *
 * token：除 /api/health、/api/status、/api/whoami、/api/stream 外全部路由要
 * Bearer master_token（http.ts:286-300 requiresMaster），故未登录时先拦一道。
 */

export function App() {
  const [active, setActive] = useState<string>(VIEWS[0]!.id);
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [status, setStatus] = useState<StatusBody | null>(null);

  // hash 路由（SF §7 未指定路由器；hash 足够且刷新可深链）
  useEffect(() => {
    const apply = (): void => {
      const h = window.location.hash.replace('#/', '');
      if (VIEWS.some((v) => v.id === h)) setActive(h);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // /api/status 免鉴权（requiresMaster:health/status/whoami → false），做顶栏状态灯
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      void api
        .status()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {
          if (alive) setStatus(null);
        });
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const current = VIEWS.find((v) => v.id === active) ?? VIEWS[0]!;

  if (token === null) {
    return <TokenGate onDone={(t) => { setToken(t); setTokenState(t); }} />;
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">dotd</div>
        {VIEWS.map((v) => (
          <a key={v.id} href={`#/${v.id}`} className={v.id === current.id ? 'nav-item active' : 'nav-item'}>
            {v.title}
          </a>
        ))}
        <div className="sidebar-foot">
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.removeItem('dotd_token');
              } catch {
                /* ignore */
              }
              setTokenState(null);
            }}
          >
            退出登录
          </button>
        </div>
      </nav>
      <main className="content">
        <header className="topbar">
          <span className={`dot ${status === null ? 'off' : 'on'}`} />
          <span className="muted">
            {status === null
              ? 'daemon 不可达'
              : `${status.service} · ${status.dotId} · 队列 ${status.queue.queued} 排 / ${status.queue.running} 跑 / ${status.queue.awaitingApproval} 待批 · bus_seq ${status.busSeq}`}
          </span>
          <span className="muted src-hint" title={sourceOf(current.id)}>
            {current.title} · 数据源见提示
          </span>
        </header>
        <current.Component />
      </main>
    </div>
  );
}

/** 未登录：收 master_token（config.yml surfaces.http.master_token）。 */
function TokenGate(props: { onDone: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = value.trim();
          if (t.length > 0) props.onDone(t);
        }}
      >
        <h1>dotd</h1>
        <p className="muted">
          输入 <code>config.yml</code> 的 <code>surfaces.http.master_token</code>（存 localStorage，仅本机）。
        </p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="master token"
          autoFocus
        />
        <button type="submit" disabled={value.trim().length === 0}>
          进入
        </button>
      </form>
    </div>
  );
}
