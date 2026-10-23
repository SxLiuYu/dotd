/**
 * A3（2026-10-21）：截图出站推送 —— 把任务的 browser.screenshot 结果随回复推给主人。
 *
 * 为什么在宿主做：截图 PNG 落在容器 home 卷（/dot/home/screenshots，持久），
 * 取回字节要靠容器的 fs.read(base64)，传飞书要宿主的网关——两端都只有宿主够得着。
 * runner 只往结果里写小元数据（path/bytes/sha256），base64 不进模型上下文、journal 不膨胀。
 *
 * 数据源：journal steps（与 tasks 同一个 db，daemon 装配时传入）。
 * 失败语义：任何一步失败只落一行日志，**绝不影响已发出的文本回复，也绝不抛**。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 单张上限：飞书图片上限 10MB，这里 8MB 截停——超大的图多半有问题，宁缺毋滥。 */
const MAX_PNG_BYTES = 8 * 1024 * 1024;
/** 每任务最多推几张（新的在前）。推多了就是刷屏。 */
const MAX_SHOTS = 3;

export interface ScreenshotPushDeps {
  /** control-plane 共用库（tasks/steps 都在这里；daemon 装配）。 */
  db: DatabaseSync;
  log(msg: string): void;
  /** 从指定 dot 容器的 home 里取回文件（base64 解码后返回）；失败 null。 */
  readHomeFile(dotId: string, path: string): Promise<Buffer | null>;
  /** 上传 PNG 并发图片消息（FeishuGateway.sendImage）。 */
  sendImage(chatId: string, png: Buffer): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 从 step 的 result_json 里解析截图路径；坏 JSON/缺 path/不在 screenshots 目录 → null。
 *
 * 2026-10-21 修真缺陷：此前只认 `{path}` 与 `{result:{path}}`，而 `steps.result_json`
 * 实际存的是 `{"output":"{\"path\":\"/dot/home/screenshots/x.png\"}"}`
 * —— 工具输出先被字符串化、又被包了一层。于是本函数**永远返回 null**，
 * 下游 `screenshot-push` 与 `progress-push` 的附图分支全部静默失效：
 * 截图在容器里造得出来（实测 67006 字节 PNG），却一张都没发出去过。
 *
 * 现在三种形状都认，并递归解 `output` 字符串（是 JSON 就再解一层）。
 * 只多认不多猜：任何一层解不出合法路径就返回 null，绝不拼路径。
 */
export function screenshotPathOf(resultJson: string): string | null {
  const okPath = (p: unknown): string | null =>
    typeof p === 'string' && p.startsWith('/dot/home/screenshots/') ? p : null;

  const fromObj = (obj: unknown, depth: number): string | null => {
    if (depth > 3 || obj === null || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    const direct = okPath(o['path']);
    if (direct !== null) return direct;
    const nested = okPath((o['result'] as { path?: unknown } | undefined)?.path);
    if (nested !== null) return nested;
    const out = o['output'];
    if (typeof out === 'string') {
      try {
        return fromObj(JSON.parse(out), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  };

  try {
    return fromObj(JSON.parse(resultJson), 0);
  } catch {
    return null;
  }
}

/** 推送一个任务的截图（新的在前，最多 MAX_SHOTS 张）。返回实际发出张数。 */
export async function pushTaskScreenshots(
  taskId: string,
  chatId: string,
  deps: ScreenshotPushDeps,
): Promise<number> {
  let rows: Array<{ result_json: string }>;
  try {
    rows = deps.db
      .prepare(
        `SELECT result_json FROM steps
         WHERE task_id=? AND tool_name='browser.screenshot' AND status='succeeded'
           AND result_json IS NOT NULL
         ORDER BY seq DESC LIMIT ${MAX_SHOTS}`,
      )
      .all(taskId) as Array<{ result_json: string }>;
  } catch (cause) {
    deps.log(`[screenshot-push] 查询失败 ${taskId}：${String(cause)}`);
    return 0;
  }
  if (rows.length === 0) return 0;
  const task = deps.db.prepare('SELECT dot_id FROM tasks WHERE id=?').get(taskId) as
    | { dot_id: string }
    | undefined;
  if (task === undefined) {
    deps.log(`[screenshot-push] 任务不存在 ${taskId}`);
    return 0;
  }
  // 2026-10-21：跨模块去重。
  //
  // 现场（任务 tk_mvi2zm3nah32ks，实测）：progress_image 台账里有 5 条，
  // 其中 shot-mvi2zy1f.png 被发了两次 —— 一次来自进度推送（过程中的新截图），
  // 一次来自这里的随单推送（任务结束时把最近 3 张再发一遍）。
  // 主人在手机上看到同一张图重复出现。
  //
  // 判据：这张图**已经成功发到同一个会话**过，就不再发。
  // 用 surf_outbound_log 当共享台账 —— 两个模块本来就都写它，
  // 不能各自维护内存状态（进程重启就丢，且互不可见）。
  const alreadySent = (path: string): boolean => {
    try {
      const row = deps.db
        .prepare(
          `SELECT 1 AS hit FROM surf_outbound_log
           WHERE kind='progress_image' AND chat_id=? AND dedup_key=? AND ok=1 LIMIT 1`,
        )
        .get(chatId, `progress:${taskId}:${path}`) as { hit?: number } | undefined;
      return row !== undefined;
    } catch {
      // 查不到就当没发过（宁可重复，不可漏发）
      return false;
    }
  };

  let sent = 0;
  for (const r of rows) {
    const path = screenshotPathOf(r.result_json);
    if (path === null) continue;
    if (alreadySent(path)) {
      deps.log(`[screenshot-push] 跳过（进度推送已经发过）${path}`);
      continue;
    }
    let png: Buffer | null = null;
    try {
      png = await deps.readHomeFile(task.dot_id, path);
    } catch (cause) {
      deps.log(`[screenshot-push] 读取失败 ${path}：${String(cause)}`);
      continue;
    }
    if (png === null || png.byteLength === 0) continue;
    if (png.byteLength > MAX_PNG_BYTES) {
      deps.log(`[screenshot-push] 跳过（过大 ${png.byteLength}B）${path}`);
      continue;
    }
    try {
      const res = await deps.sendImage(chatId, png);
      // 2026-10-23：随单截图也要落台账。
      //
      // 原来只写日志，而日志每次重启被截断（wsl-daemon.sh 用 `: > "$LOG"`）。
      // 结果「任务结束时到底补发过几张图」事后查不到 —— 主人问「怎么这么多消息」时，
      // 图片那部分完全是黑箱：progress_image 记的是**进度推送**发的图，不是这里发的。
      //
      // kind 用 task_image 与 progress_image 区分：一个跟着结论走，一个跟着过程走。
      // 混在一起统计就分不清「过程里看到了什么」和「结论配了哪张图」。
      try {
        deps.db
          .prepare(
            `INSERT INTO surf_outbound_log (kind, dedup_key, chat_id, ok, error, text_preview, at)
             VALUES ('task_image', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `taskimg:${taskId}:${path}`,
            chatId,
            res.ok ? 1 : 0,
            res.ok ? null : (res.error ?? null),
            `随单截图 ${path}`.slice(0, 200),
            new Date().toISOString(),
          );
      } catch (cause) {
        // 台账写失败不能影响发图本身：图比记录重要（与 progress-push 同策）。
        deps.log(`[screenshot-push] 写台账失败 ${path}：${String(cause)}`);
      }
      if (res.ok) {
        sent += 1;
      } else {
        deps.log(`[screenshot-push] 发送失败 ${path}：${res.error ?? '?'}`);
      }
    } catch (cause) {
      deps.log(`[screenshot-push] 发送异常 ${path}：${String(cause)}`);
    }
  }
  return sent;
}
