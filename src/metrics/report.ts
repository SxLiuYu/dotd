/**
 * src/metrics/report.ts —— 把指标渲染成人能读的一段话（2026-10-27）。
 *
 * 为什么渲染单独一层：`sample.ts` 只负责**算**，口径不许掺表现；
 * 这里只负责**说**，一个字都不改数。CLI、HTTP、飞书推送共用这一份，
 * 免得「手机看到的和终端看到的不一样」。
 *
 * 三条写法纪律
 *
 * 1. **没数据就说没数据。** 语音反射延迟目前没有观测点（voice_events 没有耗时列），
 *    报告里写「缺观测点」，不拿别的数凑。样本为 0 的分位数同理。
 *
 * 2. **好和坏都要说。** 只报好消息的仪表盘等于没有仪表盘。工具失败率 9%、
 *    149 个工具里 net.get 19% 失败 —— 这些必须出现在同一屏里。
 *
 * 3. **给基线对比位。** 单个数字说明不了「变好没有」，所以每行都留出
 *    「对比基线」的箭头位。没有基线时明说「还没有基线」，不假装有趋势。
 */

import type { MetricSample, MetricSeriesRow } from './sample.ts';

export interface ReportOptions {
  /** 对比基线（上一次人工确认的采样）。不给 = 没有基线。 */
  baseline?: MetricSample | null;
  /** 是否附上按维度拆的明细（默认附前几条最差的）。 */
  withDetail?: boolean;
}

/** 毫秒变人话：<1s 给整数毫秒，秒级给 1 位小数，分钟级给整数。 */
export function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

/** 比率变百分比。null → 「—」（不是 0%）。 */
export function fmtPct(r: number | null): string {
  if (r === null) return '—';
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * 变化幅度。返回 `null` = 无从比较（任一侧缺数据）。
 * 正数 = 变大。**方向的好坏由调用方决定**（耗时变大是坏，一次跑通率变大是好），
 * 这里只报事实，不替读者下判断。
 */
export function delta(cur: number | null, base: number | null | undefined): number | null {
  if (cur === null || base === null || base === undefined) return null;
  if (base === 0) return null;
  return (cur - base) / base;
}

/** 带方向的对比尾巴。没有基线就明说。 */
function trend(cur: number | null, base: number | null | undefined, invert = false): string {
  const d = delta(cur, base);
  if (d === null) return '';
  const pct = Math.abs(d * 100).toFixed(0);
  if (Math.abs(d) < 0.05) return '（≈ 持平）';
  const up = d > 0;
  // invert=true：变大是好事（如一次跑通率）。箭头如实反映「好坏」，不是数值方向。
  const good = invert ? up : !up;
  return `（对比基线 ${up ? '↑' : '↓'}${pct}% ${good ? '改善' : '变差'}）`;
}

/**
 * 渲染报告。结构固定三段，对应主人问的三件事：
 * 反应速度 / 执行质量 / 自我进化。
 */
export function renderReport(
  sample: MetricSample,
  opts: ReportOptions = {},
  series: readonly MetricSeriesRow[] = [],
): string {
  const b = opts.baseline ?? null;
  const days = Math.max(1, Math.round((sample.windowTo - sample.windowFrom) / 86_400_000));
  const lines: string[] = [];

  lines.push(`指标采样 · 最近 ${days} 天 · ${new Date(sample.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');

  // ── 一、反应速度 ──
  lines.push('【反应速度】');
  lines.push(
    `  任务端到端   p50 ${fmtMs(sample.speed.taskP50Ms)}  p95 ${fmtMs(sample.speed.taskP95Ms)}` +
      trend(sample.speed.taskP50Ms, b?.speed.taskP50Ms),
  );
  lines.push(
    `  单次模型调用 p50 ${fmtMs(sample.speed.modelP50Ms)}  p95 ${fmtMs(sample.speed.modelP95Ms)}` +
      trend(sample.speed.modelP50Ms, b?.speed.modelP50Ms),
  );
  if (sample.speed.reflexP50Ms === null) {
    lines.push('  语音反射     — 缺观测点（voice_events 没有耗时列，measured=none）');
  } else {
    lines.push(`  语音反射     p50 ${fmtMs(sample.speed.reflexP50Ms)}  p95 ${fmtMs(sample.speed.reflexP95Ms)}`);
  }
  lines.push('');

  // ── 二、执行质量 ──
  lines.push('【执行质量】');
  lines.push(
    `  一次跑通率   ${fmtPct(sample.quality.firstTryRate)}` +
      trend(sample.quality.firstTryRate, b?.quality.firstTryRate, true),
  );
  lines.push(
    `  工具失败率   ${fmtPct(sample.quality.toolErrRate)}（${sample.quality.toolErrors}/${sample.quality.toolCalls}）` +
      trend(sample.quality.toolErrRate, b?.quality.toolErrRate),
  );
  lines.push(
    `  模型失败率   ${fmtPct(sample.quality.modelErrRate)}（${sample.quality.modelBad}/${sample.quality.modelCalls}）` +
      trend(sample.quality.modelErrRate, b?.quality.modelErrRate),
  );
  const lateRate =
    sample.quality.approvalTotal === 0 ? null : sample.quality.approvalLate / sample.quality.approvalTotal;
  lines.push(
    `  迟到裁决占比 ${fmtPct(lateRate)}（${sample.quality.approvalLate}/${sample.quality.approvalTotal}）` +
      '  ← 高说明同一件事被问了多遍，或答复没送达',
  );
  lines.push(
    `  空转任务     ${sample.quality.runawayTasks} 个（单任务 ≥200 步）` +
      trend(sample.quality.runawayTasks, b?.quality.runawayTasks),
  );
  lines.push(
    `  终态分布     done ${sample.quality.done} / failed ${sample.quality.failed} / cancelled ${sample.quality.cancelled}`,
  );

  if (opts.withDetail === true && series.length > 0) {
    const worst = series
      .filter((r) => r.dim === 'tool' && r.n >= 20)
      .map((r) => ({ ...r, rate: r.n === 0 ? 0 : r.bad / r.n }))
      .sort((a, z) => z.rate - a.rate)
      .slice(0, 5);
    if (worst.length > 0) {
      lines.push('  最差的工具：');
      for (const r of worst) {
        lines.push(`    ${r.key.padEnd(14)} ${fmtPct(r.rate)}（${r.bad}/${r.n}）`);
      }
    }
    // 失败原因单独排一段：工具名只说明"谁倒了"，原因才说明"该修什么"。
    // 同一个根因会让一批工具一起倒（容器 quarantined 就是这样），
    // 只报工具名会把排障引到错误的方向。
    const causes = series
      .filter((r) => r.dim === 'tool_error')
      .sort((a, z) => z.n - a.n)
      .slice(0, 5);
    if (causes.length > 0) {
      lines.push('  工具失败原因：');
      for (const r of causes) {
        lines.push(`    ${r.key.padEnd(22)} ${r.n} 次`);
      }
    }
  }
  lines.push('');

  // ── 三、自我进化 ──
  lines.push('【自我进化】');
  lines.push(`  记忆规模     线程 ${sample.evolution.memThreads} / 消息 ${sample.evolution.memMessages} / 文件 ${sample.evolution.memFiles}`);
  lines.push(
    `  窗口内新增   ${sample.evolution.memFilesNew} 个记忆文件` +
      trend(sample.evolution.memFilesNew, b?.evolution.memFilesNew, true),
  );
  if (sample.evolution.rulesActive === 0) {
    // 这条必须说出来：0 条授权规则意味着「每次同类操作都还会问一遍」，
    // 是自我进化维度最直接的短板，不能只在数字里躺着。
    lines.push('  授权规则     0 条 —— 没有任何「一次点头、以后不再问」的沉淀');
  } else {
    lines.push(
      `  授权规则     ${sample.evolution.rulesActive} 条，累计省下 ${sample.evolution.rulesHits} 次提问`,
    );
  }

  return lines.join('\n');
}

/**
 * 一句话结论（飞书推送用）。
 *
 * 刻意只讲**最该看的那一个数**：主人扫一眼飞书不会去读三段报告。
 * 挑法按「会不会影响主人立刻信任系统」排序，而不是按数字大小。
 */
export function headline(sample: MetricSample): string {
  const q = sample.quality;
  const problems: string[] = [];
  if (q.runawayTasks > 0) problems.push(`${q.runawayTasks} 个任务空转（≥200 步）`);
  if (q.toolErrRate !== null && q.toolErrRate > 0.1) problems.push(`工具失败率 ${fmtPct(q.toolErrRate)}`);
  if (q.modelErrRate !== null && q.modelErrRate > 0.05) problems.push(`模型失败率 ${fmtPct(q.modelErrRate)}`);
  if (q.firstTryRate !== null && q.firstTryRate < 0.9) problems.push(`一次跑通率 ${fmtPct(q.firstTryRate)}`);

  const speed = `模型 p50 ${fmtMs(sample.speed.modelP50Ms)}`;
  return problems.length === 0
    ? `一切正常：${speed}，一次跑通 ${fmtPct(q.firstTryRate)}`
    : `${problems.join('；')}；${speed}`;
}
