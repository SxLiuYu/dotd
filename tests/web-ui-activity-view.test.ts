/**
 * tests/web-ui-activity-view.test.ts —— 活动视图（9.3 Web 侧，2026-10-21）
 *
 * Web UI 没有单元测试框架（只有 vite build 的类型门），所以这里做
 * **源码契约验证**：钉死接线没断、口径与后端一致、且没有偷偷接实时流。
 *
 * 为什么值得测：视图文件是"加了没人用"的典型死角 ——
 * 忘了在 views.tsx 登记，页面永远不出现，但 build 依然是绿的。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

const HERE = resolve(import.meta.url.replace('file://', ''), '..');
const read = (rel: string): string => readFileSync(resolve(HERE, '..', rel), 'utf8');

const view = read('web-ui/src/views/ActivityView.tsx');
const registry = read('web-ui/src/views.tsx');
const api = read('web-ui/src/api.ts');
const styles = read('web-ui/src/styles.css');
const httpSrc = read('src/surfaces/http.ts');

console.log('');
console.log('  登记与接线');

ok('ActivityView 已导出', /export function ActivityView\(\): JSX\.Element/.test(view));
ok('views.tsx import 了它', registry.includes("import { ActivityView } from './views/ActivityView.tsx'"));
ok('视图表里登记了 activity', registry.includes("id: 'activity'"));
ok('标题是「活动」', registry.includes("title: '活动'"));
ok('Component 指向 ActivityView', registry.includes('Component: ActivityView'));
// 登记表头若还写「六视图」就是漏改的痕迹
ok('文件头已改成七视图', registry.includes('七视图登记表'));
ok('数据源说明提到 /api/activity', registry.includes('/api/activity'));

console.log('');
console.log('  接口口径与后端一致');

ok('api.ts 有 activity 方法', api.includes('activity: (limit = 30, status?: string)'));
ok('打的是 GET /api/activity', api.includes("'/api/activity?'") || api.includes('`/api/activity?${q}`'));
ok('limit 与服务端默认一致（30 是前端默认，服务端 20）', api.includes('limit = 30'));
// 服务端上限 100：前端下拉不该给出超过它的选项
ok('下拉最大 100（不超服务端上限）', view.includes('[10, 30, 50, 100]'));
ok('后端确有 limit 夹逼到 100', httpSrc.includes('Math.min(Math.max(Math.trunc(rawLimit), 1), 100)'));

console.log('');
console.log('  只读语义');

// 活动是已结束的事实，接实时流会让人误以为在看直播
ok('没有订阅 SSE', !view.includes('subscribeStream'));
ok('没有取消按钮（与队列分工）', !view.includes('cancelTask'));
ok('文件头说明了为什么不接 SSE', view.includes('不会自己变'));

console.log('');
console.log('  展示口径');

// 失败步数只在真有时才显示，否则每行都是噪音
ok('失败步数有 >0 判断', view.includes('t.failedSteps > 0'));
ok('状态有中文映射', view.includes("done: '完成'") && view.includes("failed: '失败'"));
// created_at 存的是 epoch 毫秒字符串，也可能是 ISO —— 两种都要能吃
ok('时间格式化兼容两种存储', view.includes('Number.isFinite(n)') && view.includes('时间未知'));
ok('有样式（不是裸表格）', styles.includes('.activity-table'));

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
