const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.dotd/dotd.db', { readOnly: true });

console.log('=== 模型调用延迟分布（最近 100 次成功）===');
const rows = db.prepare(`
  SELECT latency_ms, prompt_tokens, completion_tokens, model, endpoint_id
  FROM model_call_log WHERE outcome='ok' ORDER BY id DESC LIMIT 100
`).all();

const lat = rows.map((r) => Number(r.latency_ms)).filter((x) => x > 0).sort((a, b) => a - b);
if (lat.length === 0) {
  console.log('  （无数据）');
} else {
  const pct = (p) => lat[Math.floor(lat.length * p)];
  console.log(`  样本 ${lat.length} 次`);
  console.log(`  p50 = ${pct(0.5)}ms`);
  console.log(`  p90 = ${pct(0.9)}ms`);
  console.log(`  p99 = ${pct(0.99)}ms`);
  console.log(`  max = ${lat[lat.length - 1]}ms`);
  console.log();
  console.log('  最慢的 8 次:');
  for (const r of rows.sort((a, b) => Number(b.latency_ms) - Number(a.latency_ms)).slice(0, 8)) {
    console.log(`    ${String(r.latency_ms).padStart(7)}ms  prompt=${r.prompt_tokens} completion=${r.completion_tokens}  ${r.model} @ ${r.endpoint_id}`);
  }
}

console.log();
console.log('=== prompt token 大小分布（看上下文是否膨胀）===');
const pt = rows.map((r) => Number(r.prompt_tokens)).filter((x) => x > 0).sort((a, b) => a - b);
if (pt.length > 0) {
  console.log(`  p50=${pt[Math.floor(pt.length * 0.5)]}  p90=${pt[Math.floor(pt.length * 0.9)]}  max=${pt[pt.length - 1]}`);
}

console.log();
console.log('=== 按模型看平均延迟 ===');
for (const r of db.prepare(`
  SELECT model, COUNT(*) c, AVG(latency_ms) avg_ms, MAX(latency_ms) max_ms, AVG(prompt_tokens) avg_pt
  FROM model_call_log WHERE outcome='ok' GROUP BY model ORDER BY c DESC LIMIT 6
`).all()) {
  console.log(`  ${String(r.model).padEnd(22)} ${String(r.c).padStart(4)} 次  平均 ${Math.round(r.avg_ms)}ms  最慢 ${r.max_ms}ms  平均 prompt ${Math.round(r.avg_pt)} tokens`);
}
db.close();
