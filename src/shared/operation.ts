/**
 * src/shared/operation.ts —— 把「工具调用」翻译成「主人能判断的具体操作」。
 *
 * 为什么需要这一层（2026-10-25 主人反馈）：
 *   审批卡片原来显示的是 `操作：shell.run` + 一大段 heredoc 脚本。对主人来说
 *   这不是一个可以判断的东西 —— 他要批的是"给王小明充 50 块话费"，
 *   不是"运行一个 42 行的 python 脚本"。于是出现两种坏结果：
 *   不看就点同意，或者根本不敢点。
 *
 * 这一层只做"翻译"，**不改变任何许可语义**：
 *   - 审批与否仍由 gate 的档位/规则决定（shell.run 依旧是 dangerous）；
 *   - 这里输出的标题/摘要/风险只是呈现，不能作为放行依据；
 *   - 原始参数仍然完整保留在卡片最后（审计需要，不能藏）。
 *
 * 翻译优先级：
 *   1. 调用方显式给的意图（params.intent / purpose / reason / description）；
 *   2. 任务标题（"我在替你做什么"）；
 *   3. 工具 + 参数的结构化解读（金额、收款方、地址、脚本行数……）。
 */

import { formatMoney, isLargeSpend, LARGE_SPEND_WARN_CENTS } from './money.ts';

export interface OperationDetail {
  label: string;
  value: string;
}

export interface OperationView {
  /** 一句话业务动作（卡片标题）。有任务标题时就是任务标题。 */
  title: string;
  /** 具体操作（人话，不含原始脚本）。 */
  action: string;
  /** 做决定必须知道的字段（金额、对象、地址……），最多 5 条。 */
  details: OperationDetail[];
  /** 从参数里能看出的风险提示，最多 3 条。 */
  risks: string[];
  /** 原始参数（脱敏、截断）—— 给审计与"我要看原文"的主人。 */
  rawParams: string;
}

export interface DescribeOperationInput {
  taskTitle?: string | null;
  tool: string;
  tier?: string | null;
  params?: unknown;
  reason?: string | null;
}

const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

/** 脱敏 + 截断。卡片是给主人看的，不该顺手把凭证印上去。 */
export function redact(text: string, max = 400): string {
  const s = text.replace(SECRET_RE, '<已隐去>');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return clip(url, 60);
  }
}

const PAY_RE =
  /(支付|付款|下单|购买|充值|转账|缴费|checkout|purchase|place[\s_-]?order|create[\s_-]?order|\bpay\b|payment)/i;
const CHANNEL_RE = /(支付宝|微信支付|美团|饿了么|京东|淘宝|拼多多|滴滴|抖音|银联|PayPal|Stripe)/i;

function moneyDetails(rec: Record<string, unknown>, cmd: string): OperationDetail[] {
  const out: OperationDetail[] = [];
  const cur = typeof rec.currency === 'string' ? rec.currency : '';
  const cents = rec.amountCents ?? rec.amount_cents;
  if (typeof cents === 'number' && Number.isFinite(cents)) {
    const shown = formatMoney(cents, cur);
    out.push({
      label: '金额',
      value: isLargeSpend(cents, LARGE_SPEND_WARN_CENTS) ? shown + '  ⚠️ 金额较大' : shown,
    });
    return out;
  }
  if (typeof rec.amount === 'number' && Number.isFinite(rec.amount)) {
    out.push({ label: '金额', value: String(rec.amount) + (cur !== '' ? ' ' + cur : '') + '（未标明单位）' });
    return out;
  }
  if (cmd !== '') {
    const m =
      /(?:amount|total|price|金额|价格|支付|付款|充值|转账)[^\d\n]{0,10}(\d+(?:\.\d{1,2})?)/i.exec(cmd) ??
      /(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块|CNY|RMB)/i.exec(cmd);
    if (m !== null && m[1] !== undefined) {
      out.push({ label: '金额', value: '约 ' + m[1] + '（从命令文本识别，请核对）' });
    }
  }
  return out;
}

interface ShellView {
  action: string;
  details: OperationDetail[];
  risks: string[];
}

function describeShell(rec: Record<string, unknown>): ShellView {
  const cmd = str(rec, ['cmd', 'command', 'script']);
  const details: OperationDetail[] = [];
  const risks: string[] = [];
  if (cmd === '') return { action: '运行一条命令（参数缺失）', details, risks };

  details.push(...moneyDetails(rec, cmd));

  const url = /https?:\/\/[^\s"'`)]+/.exec(cmd)?.[0] ?? '';
  if (url !== '') details.push({ label: '目标地址', value: hostOf(url) });

  const channel = CHANNEL_RE.exec(cmd)?.[1];
  if (channel !== undefined) details.push({ label: '渠道', value: channel });

  // heredoc / -c 脚本：不把正文当"操作"展示，只报解释器与规模。
  const heredoc = /\b(python3?|node|bash|sh|deno|ruby|perl)\b[^\n]*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/.exec(cmd);
  let action: string;
  if (heredoc !== null) {
    const lang = heredoc[1] ?? '脚本';
    const lines = cmd.split('\n').length - 1;
    action = '运行 ' + lang + ' 脚本（' + lines + ' 行）';
    if (lines > 60) risks.push('脚本较长（' + lines + ' 行），建议展开原文核对再同意');
  } else {
    const firstLine = cmd
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s !== '' && !s.startsWith('#')) ?? cmd;
    action = '运行命令：' + clip(firstLine, 90);
    if (/\bcurl\b|\bwget\b/.test(firstLine) && url !== '') action = '发起网络请求：' + hostOf(url);
  }

  if (/\brm\s+-[a-z]*[rf]/.test(cmd)) risks.push('命令包含删除操作（rm -rf）');
  if (/\bcurl\b[^\n]*\s(-k|--insecure)\b/.test(cmd) || /ssl\._create_unverified_context|verify\s*=\s*False/.test(cmd)) {
    risks.push('命令关闭了 TLS 证书校验');
  }
  if (/(^|\s)(sudo|chmod\s+777|mkfs|dd\s+if=)/.test(cmd)) risks.push('命令涉及高权限/破坏性操作');
  if (PAY_RE.test(cmd)) risks.push('这是一次支付/下单动作：请核对收款方与金额');
  if (/\b(?:os\.system|subprocess\.|eval\()/.test(cmd)) risks.push('脚本内还会再执行命令，实际动作可能超出首行');

  return { action, details, risks };
}

function describeBrowser(rec: Record<string, unknown>, tool: string): ShellView {
  const act = str(rec, ['action', 'act', 'op']) || '操作页面';
  const url = str(rec, ['url', 'href']);
  const details: OperationDetail[] = [];
  if (url !== '') details.push({ label: '目标地址', value: hostOf(url) });
  const text = str(rec, ['text', 'value', 'selector']);
  if (text !== '') details.push({ label: '输入/目标', value: redact(text, 80) });
  const channel = CHANNEL_RE.exec((url + ' ' + text).toString())?.[1];
  if (channel !== undefined) details.push({ label: '渠道', value: channel });
  const risks: string[] = [];
  if (/submit|confirm|pay|checkout|buy|order|确认|支付|付款|提交|下单|购买/i.test(act + ' ' + text)) {
    risks.push('这一步会提交/确认页面动作，可能直接下单或付款');
  }
  return { action: '浏览器：' + clip(act, 60), details, risks };
}

function describeNet(rec: Record<string, unknown>, tool: string): ShellView {
  const url = str(rec, ['url']);
  const method = tool.endsWith('.post') ? 'POST' : 'GET';
  const details: OperationDetail[] = [];
  if (url !== '') details.push({ label: '目标地址', value: hostOf(url) });
  const body = rec.body ?? rec.data;
  if (body !== undefined) details.push({ label: '请求体', value: redact(typeof body === 'string' ? body : JSON.stringify(body), 100) });
  const risks: string[] = [];
  return { action: '网络请求：' + method + ' ' + (url !== '' ? hostOf(url) : '（无地址）'), details, risks };
}

function describeMail(rec: Record<string, unknown>, tool: string): ShellView {
  const to = str(rec, ['to']);
  const subject = str(rec, ['subject']);
  const body = str(rec, ['body']);
  const details: OperationDetail[] = [];
  if (to !== '') details.push({ label: '收件人', value: clip(to, 100) });
  if (subject !== '') details.push({ label: '主题', value: clip(subject, 100) });
  if (body !== '') details.push({ label: '正文摘要', value: clip(body, 200) });
  // 静态事实（"邮件发出收不回来"）不放进 risks：risks 只放**从参数里读出来**的发现，
  // 否则"没参数也报风险"就成了编造（tests/approval-card.test.ts「没风险时不编造风险段」）。
  const risks: string[] = [];
  return { action: tool === 'mail.send' ? '发送邮件' + (to !== '' ? '给 ' + clip(to, 40) : '') : '起草邮件', details, risks };
}

function describeFs(rec: Record<string, unknown>, tool: string): ShellView {
  const details: OperationDetail[] = [];
  const one = str(rec, ['path', 'target']);
  const many = rec.paths;
  if (one !== '') details.push({ label: '路径', value: clip(one, 100) });
  else if (Array.isArray(many)) details.push({ label: '路径', value: clip(many.slice(0, 5).map(String).join(', '), 120) });
  const risks: string[] = [];
  if (tool === 'fs.remove' && /\.\.|^\/etc|^\/root|^\/var/.test(one)) risks.push('删除的是系统目录或上级路径');
  const n = Array.isArray(many) ? many.length : one !== '' ? 1 : 0;
  return {
    action: tool === 'fs.remove' ? '删除 ' + (n > 0 ? n + ' 个路径' : '文件') : tool,
    details,
    risks,
  };
}

/**
 * 把一次工具调用翻译成"主人能判断的具体操作"。
 * 纯函数：不读库、不联网、不改状态。
 */
export function describeOperation(input: DescribeOperationInput): OperationView {
  const rec = asRecord(input.params);
  const tool = input.tool;
  const intent = str(rec, ['intent', 'purpose', 'description', 'why']).slice(0, 120);

  let view: ShellView;
  if (tool === 'shell.run') view = describeShell(rec);
  else if (tool.startsWith('browser.')) view = describeBrowser(rec, tool);
  else if (tool === 'net.get' || tool === 'net.post') view = describeNet(rec, tool);
  else if (tool === 'mail.send' || tool === 'mail.draft') view = describeMail(rec, tool);
  else if (tool === 'fs.remove' || tool === 'fs.write' || tool === 'fs.read') view = describeFs(rec, tool);
  else if (tool === 'tool.invoke' || tool === 'tool.create') {
    const name = str(rec, ['name', 'path', 'script']);
    view = {
      action: (tool === 'tool.invoke' ? '执行脚本' : '创建可执行工具') + (name !== '' ? '：' + clip(name, 60) : ''),
      details: name !== '' ? [{ label: '名称', value: clip(name, 80) }] : [],
      risks: [],
    };
  } else {
    const keys = Object.keys(rec);
    view = { action: tool, details: keys.length > 0 ? [{ label: '参数', value: keys.slice(0, 6).join(', ') }] : [], risks: [] };
  }

  // 金额与任何工具都相关（spend 契约的 amountCents 不在工具名里）。
  const details = [...moneyDetails(rec, ''), ...view.details];
  if (Object.keys(rec).length > 0) {
    const keys = Object.keys(rec);
    const shown = new Set(details.map((d) => d.label));
    if (!shown.has('参数')) {
      details.push({ label: '参数项', value: String(keys.length) + ' 项（原文见下）' });
    }
  }

  const task = (input.taskTitle ?? '').trim();
  const title = task !== '' ? clip(task, 48) : intent !== '' ? clip(intent, 48) : clip(view.action, 48);
  if (intent !== '' && task !== '') details.unshift({ label: '这一步', value: intent });

  return {
    title,
    action: view.action,
    details: details.slice(0, 5),
    risks: [...new Set(view.risks)].slice(0, 3),
    rawParams: redact(JSON.stringify(rec)),
  };
}

/** 审批单 summary（≤120 字）：业务动作｜具体操作。卡片之外的地方（CLI/SSE/列表）也用它。 */
export function operationSummary(op: OperationView): string {
  const raw = op.title !== '' && op.title !== op.action ? op.title + '｜' + op.action : op.action;
  return clip(raw, 120);
}
