/**
 * src/mail/imap.ts —— 最小可用的 IMAP 客户端（T1，2026-10-20）
 *
 * 为什么自己写而不装 imapflow/nodemailer：
 *   1. 这两个包各有几十个传递依赖，dotd 现在零运行时依赖（只有 node: 内置）
 *   2. 我们只需要四件事：LOGIN / SELECT / FETCH / SEARCH + LOGOUT
 *   3. IMAP4rev1 是纯文本协议，实现这四件事约 200 行，可控
 *   4. 出了 bug 我能读到自己的每一行；第三方包的 bug 我只能等上游
 *
 * 协议要点（踩过才知道的）：
 *   - 每行以 CRLF 结尾，命令带一个自有 tag（如 `a1 LOGIN ...`）
 *   - 响应有两种：`* ...` 是数据，`<tag> OK/NO/BAD ...` 是命令结果
 *   - 字面量（literal）形式是 `{123}` 后跟 CRLF + 恰好 123 字节，**不含在行里**
 *     这是最容易写错的地方：不能按行读，必须按字节读
 *   - 字符串要加引号，内部的 " 和 \ 要转义
 *
 * 安全：
 *   - 只走 TLS（993 隐式 TLS，143 + STARTTLS）
 *   - 密码**只在 LOGIN 那一行的内存里出现**，不进日志
 *   - 超时统一 30s，避免挂死
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** 143 端口需要 STARTTLS；993 是隐式 TLS */
  starttls?: boolean;
  /**
   * 仅测试用：明文连接（不 TLS）。
   * **生产路径永远不传这个参数** —— 唯一传它的地方是 tests/mail-e2e.ts，
   * 因为测试服务器是本地明文 TCP。真实邮箱一律走 TLS。
   * 放在接口上而不是藏起来，是为了让"有明文通道"这件事可见、可审计。
   */
  __insecurePlainForTest?: boolean;
}

export interface MailSummary {
  uid: string;
  messageId: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
}

export interface MailFull extends MailSummary {
  bodyText: string;
  attachmentNames: string[];
}

const CRLF = '\r\n';
const TIMEOUT_MS = 30_000;

/** 按字节缓冲的读取器 —— IMAP 字面量必须按字节读，不能按行。 */
class Reader {
  private buf = Buffer.alloc(0);
  private closed = false;
  private err: Error | null = null;
  private waiters: Array<() => void> = [];

  constructor(sock: Socket | TLSSocket) {
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    sock.on('error', (e: Error) => {
      this.err = e;
      this.closed = true;
      this.wake();
    });
    sock.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** 等到至少有 n 字节可读。 */
  private async need(n: number): Promise<void> {
    while (this.buf.length < n) {
      if (this.err) throw this.err;
      if (this.closed) throw new Error('IMAP 连接已断开');
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, TIMEOUT_MS);
      });
    }
  }

  /** 读一行（到 CRLF 为止），返回不含 CRLF 的 Buffer。 */
  async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf(CRLF);
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx).toString('utf8');
        this.buf = this.buf.subarray(idx + 2);
        return line;
      }
      await this.need(this.buf.length + 1);
    }
  }

  /** 读恰好 n 字节。 */
  async readBytes(n: number): Promise<Buffer> {
    await this.need(n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

/** 把字符串变成 IMAP quoted string。 */
function q(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 解 quoted string（服务端返回时可能带引号）。 */
function unq(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

/**
 * 一个 IMAP 会话。**必须 close()**，否则 socket 挂着。
 * 用法：
 *   const c = await ImapClient.open(cfg);
 *   try { ... } finally { await c.close(); }
 */
export class ImapClient {
  private seq = 0;
  private constructor(
    private readonly sock: Socket | TLSSocket,
    private readonly r: Reader,
  ) {}

  static async open(cfg: ImapConfig): Promise<ImapClient> {
    const port = cfg.port;
    if (cfg.__insecurePlainForTest) {
      const raw = await new Promise<Socket>((res, rej) => {
        const s = netConnect({ host: cfg.host, port });
        s.setTimeout(TIMEOUT_MS, () => rej(new Error('IMAP 连接超时')));
        s.once('connect', () => res(s));
        s.once('error', rej);
      });
      const r0 = new Reader(raw);
      const c0 = new ImapClient(raw, r0);
      const g = await r0.readLine();
      if (!/^\*\s+(OK|PREAUTH)/i.test(g)) throw new Error('IMAP 握手失败：' + g);
      await c0.cmd('LOGIN ' + q(cfg.user) + ' ' + q(cfg.pass));
      await c0.id();
      return c0;
    }
    const sock = cfg.starttls
      ? await new Promise<Socket>((res, rej) => {
          const s = netConnect({ host: cfg.host, port });
          s.setTimeout(TIMEOUT_MS, () => rej(new Error('IMAP 连接超时')));
          s.once('connect', () => res(s));
          s.once('error', rej);
        })
      : await new Promise<TLSSocket>((res, rej) => {
          const s = tlsConnect({ host: cfg.host, port, servername: cfg.host });
          s.setTimeout(TIMEOUT_MS, () => rej(new Error('IMAP TLS 连接超时')));
          s.once('secureConnect', () => res(s));
          s.once('error', rej);
        });
    const r = new Reader(sock);
    const c = new ImapClient(sock, r);
    // 服务器先发 greeting
    const greet = await r.readLine();
    if (!/^\*\s+(OK|PREAUTH)/i.test(greet)) throw new Error(`IMAP 握手失败：${greet}`);
    if (cfg.starttls) {
      await c.cmd('STARTTLS');
      const upgraded = await new Promise<TLSSocket>((res, rej) => {
        const t = tlsConnect({ socket: sock, servername: cfg.host }, () => res(t));
        t.once('error', rej);
      });
      // 换 socket 后必须换 reader
      (c as unknown as { sock: TLSSocket }).sock = upgraded;
      (c as unknown as { r: Reader }).r = new Reader(upgraded);
    }
    await c.cmd(`LOGIN ${q(cfg.user)} ${q(cfg.pass)}`);
    await c.id();
    return c;
  }

  /**
   * 发一条命令，收到 tagged 结果为止。返回数据行（`*` 开头）和结果行。
   *
   * `mustOk` 默认 true：只要服务端回 NO/BAD 就抛错。
   * 为什么默认这么严：最初的版本不看响应码，**错密码也当成功**
   * （tests/mail-e2e.ts 的「错密码被拒」这一条抓到的就是这个）。
   * 后来者若想"容忍失败"，必须显式传 false —— 让放水这件事写在代码里。
   */
  private async cmd(raw: string, mustOk = true): Promise<{ data: string[]; result: string }> {
    const tag = `a${++this.seq}`;
    this.sock.write(`${tag} ${raw}${CRLF}`);
    const data: string[] = [];
    for (;;) {
      const line = await this.r.readLine();
      if (line.startsWith(`${tag} `)) {
        // 结果行形如 `a1 OK ...` / `a1 NO ...` / `a1 BAD ...`
        if (mustOk && /^\S+\s+(NO|BAD)\b/i.test(line)) {
          const verb = raw.split(' ')[0];
          // 错误信息里**不能带密码**：LOGIN 的参数在 raw 里
          const safe = verb === 'LOGIN' ? 'LOGIN' : raw.slice(0, 60);
          throw new Error(`IMAP ${verb} 被拒：${line.slice(tag.length + 1).slice(0, 160)}（命令：${safe}）`);
        }
        return { data, result: line };
      }
      data.push(line);
      // 字面量：行尾 {N} 表示后面紧跟 N 字节
      const m = /\{(\d+)\}$/.exec(line);
      if (m) {
        const n = Number(m[1]);
        const body = await this.r.readBytes(n);
        data[data.length - 1] = line + body.toString('utf8');
      }
    }
  }


  /**
   * 自报客户端身份（RFC 297 ID 扩展）。
   * 网易 Coremail 硬要求：LOGIN 后不先发 ID，SELECT 一律回
   * `NO SELECT Unsafe Login`（2026-10-20 接 163 实测，kefu@188.com 那个提示）。
   * mustOk=false：不支持 ID 的服务器回 BAD 时容忍，不挡登录。
   */
  private async id(): Promise<void> {
    await this.cmd('ID ("name" "dotd" "version" "1.0.0")', false);
  }
  /** SELECT 一个文件夹。返回邮件总数。 */
  async select(folder = 'INBOX'): Promise<number> {
    const { data } = await this.cmd(`SELECT ${q(folder)}`);
    for (const d of data) {
      const m = /^\*\s+(\d+)\s+EXISTS/i.exec(d);
      if (m) return Number(m[1]);
    }
    return 0;
  }

  /** 列出最近的邮件（不读正文）。limit 上限保护，防止一次拉一万封。 */
  async listRecent(limit = 20, folder = 'INBOX'): Promise<MailSummary[]> {
    const total = await this.select(folder);
    if (total === 0) return [];
    const from = Math.max(1, total - limit + 1);
    // BODY.PEEK 而不是 BODY：PEEK 不标记已读，避免把主人的未读标记弄乱
    const { data } = await this.cmd(
      `FETCH ${from}:${total} (UID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM TO SUBJECT DATE)])`,
    );
    return parseSummaries(data);
  }

  /** 按关键词搜（IMAP SEARCH 语法各家基本一致，搜 TEXT 最兼容）。 */
  async search(keyword: string, limit = 20): Promise<string[]> {
    // 关键词里的引号和反斜杠要转义，否则能被注入成别的 IMAP 命令
    const { data } = await this.cmd(`SEARCH TEXT ${q(keyword)}`);
    const uids: string[] = [];
    for (const d of data) {
      const m = /^\*\s+SEARCH\s+(.*)$/i.exec(d);
      const body = m?.[1]?.trim();
      if (body !== undefined && body !== '') uids.push(...body.split(/\s+/));
    }
    return uids.slice(-limit);
  }

  /** 按 UID 读完整邮件（含正文与附件名）。 */
  async fetchByUid(uid: string, folder = 'INBOX'): Promise<MailFull | null> {
    await this.select(folder);
    const { data } = await this.cmd(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    const raw = data.join('\r\n');
    // 找 literal 部分：`* 1 FETCH (UID 123 BODY[] {4567}` 后面跟的就是原文
    const m = /\{(\d+)\}/.exec(raw);
    if (!m) return null;
    return parseFull(raw, uid);
  }

  async close(): Promise<void> {
    try {
      await this.cmd('LOGOUT', false);
    } catch {
      /* 关闭失败不重要 */
    }
    this.sock.destroy();
  }
}

/** 解析 FETCH 的 summary 响应。 */
function parseSummaries(lines: string[]): MailSummary[] {
  const out: MailSummary[] = [];
  for (const line of lines) {
    if (!/^\*\s+\d+\s+FETCH/i.test(line)) continue;
    const uid = /\bUID\s+(\d+)/i.exec(line)?.[1] ?? '';
    if (!uid) continue;
    // header 块在 literal 里，我们已经在 cmd 里拼回 line 了
    const hdrStart = line.indexOf('\r\n\r\n');
    const head = hdrStart >= 0 ? line.slice(0, hdrStart) : line;
    out.push({
      uid,
      messageId: headerValue(head, 'Message-ID'),
      from: headerValue(head, 'From'),
      to: headerValue(head, 'To'),
      subject: headerValue(head, 'Subject'),
      date: headerValue(head, 'Date'),
    });
  }
  return out;
}

/** 从头部块里取某个字段（字段可能折行）。 */
function headerValue(head: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r\\n[!-9;-~]+:|$)`, 'im');
  const m = re.exec(head);
  const v = m?.[1];
  if (v === undefined) return null;
  return v.replace(/\r\n[ \t]+/g, ' ').trim() || null;
}

/** 解析完整邮件：正文 + 附件名。不做 MIME 深度解码，够用即可。 */
function parseFull(raw: string, uid: string): MailFull {
  const hdrEnd = raw.indexOf('\r\n\r\n');
  const head = hdrEnd >= 0 ? raw.slice(0, hdrEnd) : raw;
  const body = hdrEnd >= 0 ? raw.slice(hdrEnd + 4) : '';
  const ctype = headerValue(head, 'Content-Type') ?? 'text/plain';

  const attachmentNames: string[] = [];
  // 附件名可能叫 name= 也可能叫 filename=，还可能 RFC2047 编码（=?utf-8?B?...?=）
  for (const mm of body.matchAll(/filename\*?=(?:"([^"]+)"|([^\s;]+))/gi)) {
    const rawName = (mm[1] ?? mm[2] ?? '').trim();
    if (rawName) attachmentNames.push(decodeRfc2047(rawName));
  }

  let bodyText = '';
  if (/multipart/i.test(ctype)) {
    // 找第一个 text/plain 段
    const parts = body.split(/--[-\w]+/);
    for (const p of parts) {
      if (/Content-Type:\s*text\/plain/i.test(p)) {
        const i = p.indexOf('\r\n\r\n');
        bodyText = i >= 0 ? p.slice(i + 4).trim() : '';
        break;
      }
    }
    if (!bodyText) {
      // 没有 text/plain 就退回第一个段
      const first = parts.find((p) => p.trim().length > 20);
      if (first) {
        const i = first.indexOf('\r\n\r\n');
        bodyText = i >= 0 ? first.slice(i + 4).trim() : first.trim();
      }
    }
  } else {
    bodyText = body.trim();
  }

  // quoted-printable 常见，软换行要处理
  if (/quoted-printable/i.test(head)) {
    bodyText = bodyText
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
  }

  return {
    uid,
    messageId: headerValue(head, 'Message-ID'),
    from: headerValue(head, 'From'),
    to: headerValue(head, 'To'),
    subject: decodeRfc2047(headerValue(head, 'Subject') ?? ''),
    date: headerValue(head, 'Date'),
    bodyText: bodyText.slice(0, 20_000), // 20K 上限：再长模型也读不完，还占 token
    attachmentNames,
  };
}

/** 解 =?utf-8?B?...?= 这类编码。没解出来就返回原样，不抛错。 */
function decodeRfc2047(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString(charset.toLowerCase() as BufferEncoding);
      }
      const decoded = text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-F]{2})/gi, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(decoded, 'binary').toString(charset.toLowerCase() as BufferEncoding);
    } catch {
      return whole;
    }
  });
}