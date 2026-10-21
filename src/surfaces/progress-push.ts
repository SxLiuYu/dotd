/**
 * src/surfaces/progress-push.ts —— 把进度推到飞书（T5，2026-10-20）
 *
 * progress.ts 只做"要不要推、推什么"的纯判断；这个文件负责接线：
 * 订阅 `exec.call.finished` → 攒步数 → 过闸 → 发消息。
 *
 * 为什么订阅 exec.call.finished 而不是 task.state
 *   task.state 只在任务状态**跃迁**时发（queued→running→done），
 *   一个跑 10 分钟的任务从 running 到 done 之间一条都没有。
 *   exec.call.finished 才是"走了一步"的信号。
 *
 * 为什么不新增一张表记进度
 *   steps 表已经有全部信息（seq/kind/tool_name/status）。
 *   只需要记两个数：上次推到第几步、什么时候推的。放内存即可 ——
 *   进程重启后最坏结果是多重推一条"正在做"，代价很小；
 *   为它加表加迁移不值得。
 */
import type { DatabaseSync } from 'node:sqlite';
import { decideProgress, decideScreen, type ProgressConfig, DEFAULT_PROGRESS } from './progress.ts';
import { screenshotPathOf } from './screenshot-push.ts';

export interface ProgressPushDeps {
  db: DatabaseSync;
  bus: { on(topic: string, handler: (e: { payload: unknown }) => void | Promise<void>): () => void };
  /** 发消息的能力。不注入 = 整个功能不启用。 */
  sender?: { send(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> };
  /** 目标会话。sender 存在时必填；两者都给了才启用。 */
  chatId?: string;
  /**
   * 发图能力（9.1，2026-10-21）。不注入 = 进度只有文字（旧行为）。
   *
   * 两个能力都要有才启用附图：读得到字节（容器 home 卷）+ 发得出图片消息。
   * 只给一个没有意义 —— 读到了发不出去，或能发但没东西可发。
   */
  image?: {
    /** 从容器 home 取回文件字节；失败 null。 */
    readHomeFile(dotId: string, path: string): Promise<Buffer | null>;
    /** 上传 PNG 并发图片消息。 */
    sendImage(chatId: string, png: Buffer): Promise<{ ok: boolean; error?: string }>;
  };
  cfg?: ProgressConfig;
  log: (line: string) => void;
  now?: () => number;
}

interface TaskProgressState {
  lastPushAt: number | null;
  lastPushStep: number | null;
  /** 已经推过的最后一条 step seq，防同一事件重投 */
  lastSeenCallId: string | null;
  /** 上一次随进度发出去的截图路径（没发过 = null）。用于去重，见 decideScreen。 */
  lastImagePath: string | null;
}

/**
 * 从 browser.* 步骤的 result_json 里抽一句"现在看到什么"。
 *
 * 三种结果形态：
 *   browser.open      → { url, title }           → "标题 — 域名"
 *   browser.snapshot  → Playwright a11y 结构文本  → 前若干个叶子节点名
 *   browser.act       → { url, ok, action }      → "已<动作>，在<域名>"
 *
 * 解析不了就返回 null（宁可不说，不说错的）。
 */
export function screenOf(tool: string, resultJson: string): string | null {
  let v: Record<string, unknown>;
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    // okResult 可能把业务值包在 value 里，也可能直接就是值
    v =
      parsed !== null && typeof parsed === 'object' && 'value' in (parsed as Record<string, unknown>)
        ? ((parsed as Record<string, unknown>).value as Record<string, unknown>)
        : (parsed as Record<string, unknown>);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object') return null;

  if (tool === 'browser.open') {
    const title = typeof v['title'] === 'string' ? (v['title'] as string).trim() : '';
    const host = hostOf(typeof v['url'] === 'string' ? (v['url'] as string) : '');
    if (title !== '') return (title + (host !== '' ? ' — ' + host : '')).slice(0, 200);
    return host !== '' ? host : null;
  }

  if (tool === 'browser.act') {
    const host = hostOf(typeof v['url'] === 'string' ? (v['url'] as string) : '');
    const act = typeof v['action'] === 'string' ? (v['action'] as string) : '';
    const who = host !== '' ? host : '页面';
    return (`已在 ${who}` + (act !== '' ? `（刚做了 ${act.slice(0, 30)}）` : '')).slice(0, 200);
  }

  if (tool === 'browser.snapshot') {
    // snapshot 的形态有两种（取决于运行时）：
    //   Playwright 的 a11y 文本：  `- heading "登录" [level=1]`
    //   结构化节点数组：          [{ role:'heading', name:'登录', children:[...] }]
    // 两种都试，认不出来退回域名 —— 至少主人知道"它在看哪个站"。
    const tree = v['tree'] ?? v['snapshot'] ?? v['aria'] ?? v;
    const names: string[] = [];
    if (typeof tree === 'string') collectAriaNames(tree, names);
    else collectNodeNames(tree, names);
    if (names.length > 0) return names.join(' / ').slice(0, 200);
    const url = typeof v['url'] === 'string' ? (v['url'] as string) : '';
    return url !== '' ? hostOf(url) : null;
  }
  return null;
}

/** 递归收 a11y 节点的 name（深度上限防环，数量上限防刷屏）。 */
function collectNodeNames(node: unknown, out: string[], depth = 0): void {
  if (out.length >= 4 || depth > 6) return;
  if (typeof node === 'string') {
    collectAriaNames(node, out);
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectNodeNames(n, out, depth + 1);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
  if (name !== '' && !out.includes(name)) out.push(name);
  collectNodeNames(o['children'], out, depth + 1);
}

/** 从 Playwright aria 文本里取引号内的名字。 */
function collectAriaNames(text: string, out: string[]): void {
  for (const line of text.split('\n')) {
    if (out.length >= 4) return;
    const m = /"[^"]+"|'[^']+'/.exec(line);
    if (m === null) continue;
    const name = m[0].slice(1, -1).trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
}

/** 取 URL 的域名部分（主人认域名比认整条 URL 快）。 */
function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m !== null ? (m[1] ?? '') : '';
}

/**
 * 把一张截图随进度发出去（9.1，2026-10-21）。
 *
 * 失败语义与 screenshot-push 一致：**只落一行日志，绝不抛、绝不影响文字**。
 * 进度是展示面，图发不出去最多是少一张图，不能因此丢掉"在干什么"这句话。
 *
 * 成功后把路径记进 st.lastImagePath —— 下次同一张图就不再发。
 * 失败**不记** —— 下次还有机会补发（与文字发送同策）。
 */
async function sendShot(
  taskId: string,
  path: string,
  st: TaskProgressState,
  deps: ProgressPushDeps,
): Promise<void> {
  const img = deps.image!;
  const task = deps.db.prepare('SELECT dot_id FROM tasks WHERE id=?').get(taskId) as
    | { dot_id: string }
    | undefined;
  if (task === undefined) return;
  let png: Buffer | null = null;
  try {
    png = await img.readHomeFile(task.dot_id, path);
  } catch (cause) {
    deps.log(`[progress] 读图失败 ${path}：${String(cause)}`);
    return;
  }
  if (png === null || png.byteLength === 0) {
    deps.log(`[progress] 读图为空 ${path}`);
    return;
  }
  // 飞书图片上限 10MB；进度里带图宁缺毋滥，8MB 就截停（与 screenshot-push 同口径）
  if (png.byteLength > 8 * 1024 * 1024) {
    deps.log(`[progress] 跳过过大截图（${png.byteLength}B）${path}`);
    return;
  }
  try {
    const res = await img.sendImage(deps.chatId!, png);
    if (res.ok) {
      st.lastImagePath = path;
      deps.log(`[progress] ${taskId} 随进度发了截图（${png.byteLength}B）`);
    } else {
      deps.log(`[progress] 截图发送失败 ${path}：${res.error ?? '?'}`);
    }
  } catch (cause) {
    deps.log(`[progress] 截图发送异常 ${path}：${String(cause)}`);
  }
}

/**
 * 启动进度推送。返回 stop。
 *
 * 注意：**默认不启用**（ProgressConfig.enabled 默认 false）。
 * 调用方必须显式传 enabled: true 才会推 —— 升级后不会突然刷屏。
 */
export function startProgressPush(deps: ProgressPushDeps): () => void {
  const cfg = deps.cfg ?? DEFAULT_PROGRESS;
  const now = deps.now ?? (() => Date.now());

  if (!cfg.enabled || deps.sender === undefined || deps.chatId === undefined || deps.chatId === '') {
    deps.log('[progress] 过程可视化未启用（需要 enabled + sender + chatId 三者齐备）');
    return () => undefined;
  }

  const state = new Map<string, TaskProgressState>();

  const unsubscribe = deps.bus.on('exec.call.finished', async (e) => {
    const p = e.payload as { taskId?: unknown; tool?: unknown; callId?: unknown; status?: unknown };
    if (typeof p.taskId !== 'string' || p.taskId === '') return;

    const taskId = p.taskId;
    const callId = typeof p.callId === 'string' ? p.callId : '';
    const st = state.get(taskId) ?? {
      lastPushAt: null,
      lastPushStep: null,
      lastSeenCallId: null,
      lastImagePath: null,
    };

    // 同一 callId 重投直接忽略（总线不保证不重投）
    if (callId !== '' && st.lastSeenCallId === callId) return;
    st.lastSeenCallId = callId !== '' ? callId : st.lastSeenCallId;

    // 从库里读真实步数与最近几步 —— 不靠内存计数，
    // 因为审批续跑会让 step 序列跳号，内存计数会漂。
    let stepCount = 0;
    let recent: Array<{ kind: 'llm' | 'tool'; toolName: string | null; status: string }> = [];
    let title = '';
    let screen: string | null = null;
    /** 本次可附的截图路径（最近一条成功的 browser.screenshot）。 */
    let imagePath: string | null = null;
    try {
      const row = deps.db
        .prepare('SELECT count(*) AS c FROM steps WHERE task_id=?')
        .get(taskId) as { c?: number } | undefined;
      stepCount = row?.c ?? 0;
      const rows = deps.db
        .prepare(
          'SELECT kind, tool_name AS toolName, status, result_json AS resultJson FROM steps WHERE task_id=? ORDER BY seq DESC LIMIT 5',
        )
        .all(taskId) as Array<{
        kind: 'llm' | 'tool';
        toolName: string | null;
        status: string;
        resultJson: string | null;
      }>;
      recent = rows.map((r) => ({ kind: r.kind, toolName: r.toolName, status: r.status }));
      // 9.1：找最近一张真截图（browser.screenshot 落盘 PNG）。
      // 只取一张 —— 进度是"现在看到什么"，不是相册。
      if (deps.image !== undefined) {
        const shot = deps.db
          .prepare(
            `SELECT result_json AS resultJson FROM steps
             WHERE task_id=? AND tool_name='browser.screenshot' AND status='succeeded'
               AND result_json IS NOT NULL
             ORDER BY seq DESC LIMIT 1`,
          )
          .get(taskId) as { resultJson?: string | null } | undefined;
        if (typeof shot?.resultJson === 'string') {
          imagePath = screenshotPathOf(shot.resultJson);
        }
      }
      // 画面：取最近一个成功的 browser.* 步骤的结果摘要
      for (const r of rows) {
        if (r.toolName === null || !r.toolName.startsWith('browser.')) continue;
        if (r.status !== 'succeeded' || r.resultJson === null) continue;
        const sc = screenOf(r.toolName, r.resultJson);
        if (sc !== null) {
          screen = sc;
          break;
        }
      }
      const t = deps.db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId) as
        | { title?: string }
        | undefined;
      title = t?.title ?? '';
    } catch (cause) {
      deps.log(`[progress] 读步骤失败（${taskId}）：${String(cause)}`);
      return;
    }

    // 失败的一步 = 需要人看一眼
    const needsAttention =
      p.status === 'error' || recent.some((r) => r.status === 'failed' || r.status === 'interrupted');

    const decision = decideProgress(
      {
        taskId,
        title: title !== '' ? title : '任务',
        stepCount,
        recentSteps: recent,
        now: now(),
        lastPushAt: st.lastPushAt,
        lastPushStep: st.lastPushStep,
        needsAttention,
        screen,
      },
      cfg,
    );

    if (!decision.push) {
      state.set(taskId, st);
      return;
    }

    // 9.1：先定要不要带图（纯判断，可测），再发。
    const wantImage = decideScreen(imagePath, st.lastImagePath, needsAttention);

    const r = await deps.sender!.send(deps.chatId!, decision.text);
    if (r.ok) {
      st.lastPushAt = now();
      st.lastPushStep = stepCount;
      deps.log(`[progress] ${taskId} 推了进度（${decision.reason}，${stepCount} 步）`);
    } else {
      // 发失败不落账 —— 下一次还有机会补。落账会让"正好那条最该看的"永久丢失。
      deps.log(`[progress] ${taskId} 进度推送失败：${r.error ?? '?'}`);
    }

    // 图独立于文字成败：文字发失败也值得试一次图？（不）
    // 理由：图文是一条消息的两半，文字都没发出去说明这个 chat 有问题，
    //       再发图大概率也失败，还会把限流打满。所以只在文字成功后才发图。
    if (r.ok && wantImage !== null && deps.image !== undefined) {
      await sendShot(taskId, wantImage, st, deps);
    }

    state.set(taskId, st);
  });

  // task 结束时清状态，防 map 无限增长
  const unsubscribeDone = deps.bus.on('task.state', (e) => {
    const p = e.payload as { taskId?: unknown; to?: unknown };
    if (typeof p.taskId !== 'string') return;
    const to = typeof p.to === 'string' ? p.to : '';
    if (to === 'done' || to === 'failed' || to === 'cancelled') state.delete(p.taskId);
  });

  deps.log(
    `[progress] 过程可视化已启用（每 ${cfg.everyNSteps} 步 / 至少隔 ${Math.round(cfg.minIntervalMs / 1000)} 秒）`,
  );

  return () => {
    unsubscribe();
    unsubscribeDone();
  };
}