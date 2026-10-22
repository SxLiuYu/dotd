/**
 * src/shared/recover-text-calls.ts —— 从**正文里**兜底捞回工具调用（2026-10-22）。
 *
 * ## 为什么需要
 * 实测（任务 tk_mvj8q7lgs3qyia，24 轮）：deepseek-v4.1-flash 偶发把工具调用
 * 渲染成**正文文本**而不是结构化的 `tool_calls`：
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="shell.run">
 *   <｜｜DSML｜｜ parameter name="cmd" string="true">curl -sS ...</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * 这一轮 `toolCalls` 为空、正文非空，于是 runner 判成「完结轮」——任务
 * `status=done`，但主人收到的最后一句就是这堆裸标签。**任务显示成功，实际空转**。
 *
 * ## 边界（重要）
 * 只在**结构化 toolCalls 为空**时兜底。有结构化调用时绝不动正文——
 * 否则模型真在正文里写示例代码也会被误当调用执行。
 *
 * ## 不用正则死磕的原因
 * parameter 的正文里可能出现任意字符（含引号、换行、甚至 `</...parameter>` 的
 * 转义形式），单一正则容易截断。这里按标签**扫描**，content 取两个标签之间的原文。
 */

import type { AggregatedToolCall } from './tool-stream.ts';

/** DSML 的分隔符（全角竖线 U+FF5C ×2）。也接受 ASCII 竖线的等价写法。 */
const SEP = String.raw`(?:｜｜DSML｜｜|\|\|DSML\|\|)`;

/** 一个 `<SEP invoke name="X">…</SEP invoke>` 块。 */
const INVOKE_RE = new RegExp(
  String.raw`<${SEP}\s*invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)</${SEP}\s*invoke\s*>`,
  'gi',
);

/** 块内的 `<SEP parameter name="K" string="bool">…</SEP parameter>`。 */
const PARAM_RE = new RegExp(
  String.raw`<${SEP}\s*parameter\s+name\s*=\s*"([^"]+)"(?:\s+string\s*=\s*"(true|false)")?\s*>([\s\S]*?)</${SEP}\s*parameter\s*>`,
  'gi',
);

/** 判断正文里到底有没有这种块（便宜的前置检查，避免每轮跑正则）。 */
export function looksLikeTextToolCall(content: string): boolean {
  return /DSML/.test(content) && /invoke\s+name\s*=/i.test(content);
}

/**
 * 从正文里捞出工具调用。
 *
 * @param content 模型这一轮的正文
 * @param newId  生成 call_id 的工厂（保持与仓库其它 callId 同源；默认 ulid 风格）
 * @returns 捞到的调用；一个都捞不到返回空数组（调用方据此保持原判据）
 */
export function recoverTextToolCalls(
  content: string,
  newId: (index: number) => string = (i) => `recovered_${String(i)}`,
): AggregatedToolCall[] {
  if (!looksLikeTextToolCall(content)) return [];

  const out: AggregatedToolCall[] = [];
  INVOKE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = INVOKE_RE.exec(content)) !== null) {
    const name = (m[1] ?? '').trim();
    const body = m[2] ?? '';
    if (name === '') continue;

    const args: Record<string, unknown> = {};
    PARAM_RE.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = PARAM_RE.exec(body)) !== null) {
      const key = (p[1] ?? '').trim();
      const isString = (p[2] ?? '').toLowerCase() === 'true';
      const raw = p[3] ?? '';
      if (key === '') continue;
      // string="true"（或未标注）→ 原样收；string="false" → 尝试按 JSON 解析
      // （数字/布尔/对象）。解析失败就退回原文本，不因一个参数丢掉整轮调用。
      if (isString) {
        args[key] = raw;
      } else {
        const t = raw.trim();
        try {
          args[key] = t === '' ? '' : (JSON.parse(t) as unknown);
        } catch {
          args[key] = raw;
        }
      }
    }

    out.push({ id: newId(idx), name, arguments: JSON.stringify(args) });
    idx += 1;
  }
  return out;
}

/**
 * 把正文里的调用块**抹掉**，只留下模型真正对人说的话。
 *
 * 用途：兜底恢复调用后，这一轮正文不该再原样进上下文（否则模型下一轮会
 * 看到自己那堆标签，可能跟着模仿）。捞干净后若只剩空白，调用方按"无正文"处理。
 */
export function stripTextToolCalls(content: string): string {
  if (!looksLikeTextToolCall(content)) return content;
  const withoutBlocks = content.replace(
    new RegExp(String.raw`<${SEP}\s*calls\s*>[\s\S]*?</${SEP}\s*calls\s*>`, 'gi'),
    '',
  );
  const leftover = withoutBlocks.replace(INVOKE_RE, '');
  return leftover.replace(/\n{3,}/g, '\n\n').trim();
}
