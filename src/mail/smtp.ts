/**
 * src/mail/smtp.ts —— 最小可用的 SMTP 发送（T1/T2，2026-10-20）
 *
 * 只做一件事：把一封已经组装好的邮件发出去。
 * **不负责审批** —— 审批在上层（ExecService），这里只管技术动作。
 *
 * 为什么也自己写：
 *   和 imap.ts 同理，nodemailer 太重。SMTP 更简单：
 *   EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → . → QUIT
 *
 * 为什么不支持无认证的开放中继：那是垃圾邮件的来源，我们不做。
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** 587 端口用 STARTTLS；465 是隐式 TLS */
  starttls?: boolean;
  /** 仅测试用：明文连接。生产路径永不传，理由见 imap.ts 同名字段。 */
  __insecurePlainForTest?: boolean;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  attachments?: Array<{ name: string; contentBase64: string; mime: string }>;
}

const CRLF = '\r\n';
const TIMEOUT_MS = 30_000;

/** 按行读的简易通道（SMTP 全是文本，多行响应以 `250-` 续、`250 ` 结束）。 */
class Channel {
  private buf = '';
  private waiters: Array<() => void> = [];
  private err: Error | null = null;
  constructor(private sock: Socket | TLSSocket) {
    sock.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      this.wake();
    });
    sock.on('error', (e: Error) => {
      this.err = e;
      this.wake();
    });
    sock.on('close', () => this.wake());
  }
  private wake() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
  /** 读一条完整响应（多行会拼起来）。 */
  async reply(): Promise<string> {
    for (;;) {
      const lines = this.buf.split(CRLF);
      // 找一条 `<3位码><空格>` 结尾的行
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/^\d{3} /.test(line)) {
          const consumed = lines.slice(0, i + 1).join(CRLF) + CRLF;
          this.buf = this.buf.slice(consumed.length);
          return lines.slice(0, i + 1).join('\n');
        }
      }
      if (this.err) throw this.err;
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, TIMEOUT_MS);
      });
    }
  }
  write(s: string) {
    this.sock.write(s);
  }
  destroy() {
    this.sock.destroy();
  }
}

/** 把响应码取出来。 */
function codeOf(reply: string): number {
  const m = /^(\d{3})/m.exec(reply);
  return m ? Number(m[1]) : 0;
}

/**
 * 发一封邮件。**成功返回 messageId，失败抛错**。
 * 调用方（Executor）负责把失败原因写进 results。
 */
export async function sendMail(cfg: SmtpConfig, mail: OutgoingMail): Promise<string> {
  const sock = (cfg.starttls || cfg.__insecurePlainForTest)
    ? await new Promise<Socket>((res, rej) => {
        const s = netConnect({ host: cfg.host, port: cfg.port });
        s.setTimeout(TIMEOUT_MS, () => rej(new Error('SMTP 连接超时')));
        s.once('connect', () => res(s));
        s.once('error', rej);
      })
    : await new Promise<TLSSocket>((res, rej) => {
        const s = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host });
        s.setTimeout(TIMEOUT_MS, () => rej(new Error('SMTP TLS 连接超时')));
        s.once('secureConnect', () => res(s));
        s.once('error', rej);
      });

  let ch = new Channel(sock);

  const expect = async (want: number[], step: string) => {
    const r = await ch.reply();
    const c = codeOf(r);
    if (!want.includes(c)) throw new Error(`SMTP ${step} 失败（期望 ${want.join('/')}，实际 ${c}）：${r.slice(0, 200)}`);
    return r;
  };

  try {
    await expect([220], '握手');

    const ehlo = await (async () => {
      ch.write(`EHLO dotd${CRLF}`);
      return expect([250], 'EHLO');
    })();

    if (cfg.starttls) {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('服务器不支持 STARTTLS，拒绝明文发送密码');
      ch.write(`STARTTLS${CRLF}`);
      await expect([220], 'STARTTLS');
      const upgraded = await new Promise<TLSSocket>((res, rej) => {
        const t = tlsConnect({ socket: sock, servername: cfg.host }, () => res(t));
        t.once('error', rej);
      });
      ch.destroy();
      ch = new Channel(upgraded);
      ch.write(`EHLO dotd${CRLF}`);
      await expect([250], 'EHLO(TLS)');
    }

    // AUTH LOGIN：用户名和密码各 base64 一行
    ch.write(`AUTH LOGIN${CRLF}`);
    await expect([334], 'AUTH LOGIN');
    ch.write(`${Buffer.from(cfg.user, 'utf8').toString('base64')}${CRLF}`);
    await expect([334], 'AUTH user');
    ch.write(`${Buffer.from(cfg.pass, 'utf8').toString('base64')}${CRLF}`);
    await expect([235], 'AUTH pass'); // 235 = 认证成功

    ch.write(`MAIL FROM:<${cfg.user}>${CRLF}`);
    await expect([250], 'MAIL FROM');

    const rcpts = [...mail.to, ...(mail.cc ?? [])];
    if (rcpts.length === 0) throw new Error('没有收件人');
    for (const r of rcpts) {
      ch.write(`RCPT TO:<${r}>${CRLF}`);
      await expect([250, 251], `RCPT ${r}`);
    }

    ch.write(`DATA${CRLF}`);
    await expect([354], 'DATA');

    const raw = buildMessage(cfg.user, mail);
    // 点号行转义：正文里单独一个 . 会被当成结束符，必须写成 ..
    const escaped = raw.replace(/^\.$/gm, '..');
    ch.write(escaped + CRLF + `.${CRLF}`);
    await expect([250], 'DATA body');

    ch.write(`QUIT${CRLF}`);
    try {
      await ch.reply();
    } catch {
      /* QUIT 的响应丢了不影响结论 */
    }

    return messageIdOf(raw);
  } finally {
    ch.destroy();
  }
}

/** 组装 RFC5322 报文。**这是要发给别人的东西，格式必须对**。 */
function buildMessage(from: string, m: OutgoingMail): string {
  const id = `<${Date.now()}.${Math.random().toString(36).slice(2)}@dotd>`;
  const h: string[] = [
    `From: ${from}`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'MIME-Version: 1.0',
  ];

  const atts = m.attachments ?? [];
  if (atts.length === 0) {
    h.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    const body = Buffer.from(m.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
    return h.join(CRLF) + CRLF + CRLF + body + CRLF;
  }

  // multipart：正文一段 + 每个附件一段
  const boundary = `----dotd_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  h.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  parts.push(
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  );
  for (const a of atts) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${encodeHeader(a.name)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(a.name)}"`,
      '',
      a.contentBase64.replace(/.{76}/g, '$&\r\n'),
    );
  }
  parts.push(`--${boundary}--`);
  return h.join(CRLF) + CRLF + CRLF + parts.join(CRLF) + CRLF;
}

function messageIdOf(raw: string): string {
  return /^Message-ID:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? '';
}

/** 非 ASCII 主题要 RFC2047 编码，否则会变乱码。 */
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}