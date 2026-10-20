/**
 * src/mail/MailService.ts —— 邮件能力的编排层（T1/T2，2026-10-20）
 *
 * 职责边界：
 *   - 管账号（增删查、凭证加解密）
 *   - 调 imap.ts / smtp.ts 干活
 *   - 管草稿（存在 mail_drafts，**不自动发**）
 *   - 缓存读过的邮件（mail_messages）
 *
 * **不负责**：审批。审批在上层 —— mail.send 被调用时 ExecService 先写 approvals，
 * 人点同意后才会走到这里的 sendDraft()。这样设计的理由：
 * 如果审批逻辑埋在这里，任何绕过 ExecService 的调用路径都能发信。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { encryptSecret, decryptSecret } from './crypto.ts';
import { ImapClient, type MailSummary, type MailFull } from './imap.ts';
import { sendMail, type OutgoingMail } from './smtp.ts';

export interface AccountInput {
  label: string;
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** 明文密码，进来就加密，**不落任何日志** */
  password: string;
  starttls?: boolean;
}

export interface AccountRow {
  id: string;
  dot_id: string;
  label: string;
  email: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  status: string;
  last_ok_at: string | null;
  last_error: string | null;
}

const now = () => new Date().toISOString();

export class MailService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly keyB64: string,
  ) {}

  // ── 账号 ──────────────────────────────────────────────────────────

  addAccount(dotId: string, input: AccountInput): AccountRow {
    const id = 'ma_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const t = now();
    // 密码只在这一个表达式里是明文，之后永远是密文
    const enc = encryptSecret(input.password, this.keyB64);
    this.db
      .prepare(
        'INSERT INTO mail_accounts ' +
          '(id, dot_id, label, email, imap_host, imap_port, smtp_host, smtp_port, secret_enc, status, created_at, updated_at) ' +
          "VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)",
      )
      .run(
        id,
        dotId,
        input.label,
        input.email,
        input.imapHost,
        input.imapPort,
        input.smtpHost,
        input.smtpPort,
        enc,
        t,
        t,
      );
    return this.getAccount(dotId, id)!;
  }

  listAccounts(dotId: string): AccountRow[] {
    return this.db
      .prepare(
        'SELECT id, dot_id, label, email, imap_host, imap_port, smtp_host, smtp_port, ' +
          'status, last_ok_at, last_error ' +
          "FROM mail_accounts WHERE dot_id = ? AND status = 'active' ORDER BY created_at",
      )
      .all(dotId) as unknown as AccountRow[];
  }

  getAccount(dotId: string, idOrLabel: string): AccountRow | null {
    const rows = this.db
      .prepare(
        'SELECT id, dot_id, label, email, imap_host, imap_port, smtp_host, smtp_port, ' +
          'status, last_ok_at, last_error ' +
          'FROM mail_accounts ' +
          "WHERE dot_id = ? AND status = 'active' AND (id = ? OR label = ? OR email = ?) " +
          'LIMIT 1',
      )
      .all(dotId, idOrLabel, idOrLabel, idOrLabel) as unknown as AccountRow[];
    return rows[0] ?? null;
  }

  removeAccount(dotId: string, idOrLabel: string): boolean {
    const a = this.getAccount(dotId, idOrLabel);
    if (!a) return false;
    // 软删：标记 disabled 而不是 DELETE。历史草稿/邮件还引用着它。
    this.db
      .prepare("UPDATE mail_accounts SET status='disabled', updated_at=? WHERE id=?")
      .run(now(), a.id);
    return true;
  }

  private secretOf(account: AccountRow): { user: string; pass: string } {
    const row = this.db
      .prepare('SELECT secret_enc FROM mail_accounts WHERE id = ?')
      .get(account.id) as { secret_enc: string } | undefined;
    if (!row) throw new Error('账号不存在');
    const plain = decryptSecret(row.secret_enc, this.keyB64);
    // 存的是 user\0pass，避免再开一列
    const [user, pass] = plain.split('\u0000');
    if (!user || !pass) throw new Error('凭证损坏（解密后格式不对）');
    return { user, pass };
  }

  private markResult(account: AccountRow, err?: string) {
    this.db
      .prepare('UPDATE mail_accounts SET last_ok_at=?, last_error=?, updated_at=? WHERE id=?')
      .run(err ? account.last_ok_at : now(), err ?? null, now(), account.id);
  }

  private async withImap<T>(acc: AccountRow, fn: (c: ImapClient) => Promise<T>): Promise<T> {
    const s = this.secretOf(acc);
    const c = await ImapClient.open({
      host: acc.imap_host,
      port: acc.imap_port,
      user: s.user,
      pass: s.pass,
      starttls: acc.imap_port === 143,
    });
    try {
      const r = await fn(c);
      this.markResult(acc);
      return r;
    } catch (e) {
      this.markResult(acc, (e as Error).message);
      throw e;
    } finally {
      await c.close();
    }
  }

  // ── 读 ────────────────────────────────────────────────────────────

  /** 列最近邮件。**不标记已读**（用 BODY.PEEK）。 */
  async list(dotId: string, idOrLabel: string, limit = 20): Promise<MailSummary[]> {
    const acc = this.getAccount(dotId, idOrLabel);
    if (!acc) throw new Error('找不到邮箱账号：' + idOrLabel);
    const n = Math.min(Math.max(limit, 1), 50);
    return this.withImap(acc, (c) => c.listRecent(n));
  }

  /** 读单封（含正文与附件名）。读过的进缓存。 */
  async read(dotId: string, idOrLabel: string, uid: string): Promise<MailFull | null> {
    const acc = this.getAccount(dotId, idOrLabel);
    if (!acc) throw new Error('找不到邮箱账号：' + idOrLabel);
    return this.withImap(acc, async (c) => {
      const m = await c.fetchByUid(uid);
      if (m) this.cacheMessage(acc, m);
      return m;
    });
  }

  /** 关键词搜索。 */
  async search(dotId: string, idOrLabel: string, keyword: string, limit = 20): Promise<MailSummary[]> {
    const acc = this.getAccount(dotId, idOrLabel);
    if (!acc) throw new Error('找不到邮箱账号：' + idOrLabel);
    return this.withImap(acc, async (c) => {
      const uids = await c.search(keyword, limit);
      const out: MailSummary[] = [];
      for (const uid of uids) {
        const m = await c.fetchByUid(uid);
        if (m) {
          this.cacheMessage(acc, m);
          out.push(withoutBody(m));
        }
      }
      return out;
    });
  }

  private cacheMessage(acc: AccountRow, m: MailFull) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO mail_messages ' +
          '(id, dot_id, account_id, uid, folder, message_id, from_addr, to_addr, subject, sent_at, body_text, attachment_names, fetched_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        acc.id + ':' + m.uid,
        acc.dot_id,
        acc.id,
        m.uid,
        'INBOX',
        m.messageId,
        m.from,
        m.to,
        m.subject,
        m.date,
        m.bodyText,
        JSON.stringify(m.attachmentNames),
        now(),
      );
  }

  // ── 起草（不发送）────────────────────────────────────────────────

  /**
   * 起草一封邮件。**这不会发出去**，只是写进 mail_drafts。
   * 为什么要单独存：审批时要给主人看"它准备发什么"，得有原文可引用。
   */
  createDraft(
    dotId: string,
    idOrLabel: string,
    d: {
      to: string[];
      cc?: string[];
      subject: string;
      body: string;
      inReplyTo?: string;
      taskId?: string;
      attachments?: Array<{ name: string; contentBase64: string; mime: string }>;
    },
  ): string {
    const acc = this.getAccount(dotId, idOrLabel);
    if (!acc) throw new Error('找不到邮箱账号：' + idOrLabel);
    const id = 'md_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const t = now();
    this.db
      .prepare(
        'INSERT INTO mail_drafts ' +
          '(id, dot_id, account_id, task_id, to_json, cc_json, subject, body, in_reply_to, attachments_json, status, created_at, updated_at) ' +
          "VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?)",
      )
      .run(
        id,
        dotId,
        acc.id,
        d.taskId ?? null,
        JSON.stringify(d.to),
        JSON.stringify(d.cc ?? []),
        d.subject,
        d.body,
        d.inReplyTo ?? null,
        JSON.stringify(d.attachments ?? []),
        t,
        t,
      );
    return id;
  }

  getDraft(dotId: string, draftId: string) {
    return this.db
      .prepare('SELECT * FROM mail_drafts WHERE dot_id = ? AND id = ?')
      .get(dotId, draftId) as Record<string, unknown> | undefined;
  }

  /**
   * 真的把草稿发出去。
   * **只能被审批通过后的路径调用** —— 谁调用谁负责证明审批过了。
   */
  async sendDraft(
    dotId: string,
    draftId: string,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const row = this.getDraft(dotId, draftId);
    if (!row) return { ok: false, error: '找不到草稿：' + draftId };
    if (row.status === 'sent') return { ok: false, error: '这封草稿已经发过了' };
    if (row.status === 'discarded') return { ok: false, error: '这封草稿已作废' };

    const acc = this.getAccount(dotId, String(row.account_id));
    if (!acc) return { ok: false, error: '账号已停用或不存在' };
    const s = this.secretOf(acc);

    const out: OutgoingMail = {
      from: acc.email,
      to: JSON.parse(String(row.to_json)) as string[],
      cc: JSON.parse(String(row.cc_json)) as string[],
      subject: String(row.subject),
      body: String(row.body),
      inReplyTo: row.in_reply_to ? String(row.in_reply_to) : undefined,
      attachments: JSON.parse(String(row.attachments_json)) as OutgoingMail['attachments'],
    };

    try {
      const mid = await sendMail(
        {
          host: acc.smtp_host,
          port: acc.smtp_port,
          user: s.user,
          pass: s.pass,
          starttls: acc.smtp_port === 587,
        },
        out,
      );
      this.db
        .prepare("UPDATE mail_drafts SET status='sent', sent_at=?, updated_at=? WHERE id=?")
        .run(now(), now(), draftId);
      this.markResult(acc);
      return { ok: true, messageId: mid };
    } catch (e) {
      const msg = (e as Error).message;
      this.markResult(acc, msg);
      return { ok: false, error: msg };
    }
  }

  discardDraft(dotId: string, draftId: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE mail_drafts SET status='discarded', updated_at=? WHERE dot_id=? AND id=? AND status='draft'",
      )
      .run(now(), dotId, draftId);
    return Number(r.changes) > 0;
  }

  listDrafts(dotId: string) {
    return this.db
      .prepare(
        'SELECT id, account_id, subject, to_json, status, created_at ' +
          "FROM mail_drafts WHERE dot_id = ? AND status='draft' ORDER BY created_at DESC LIMIT 20",
      )
      .all(dotId) as unknown as Array<Record<string, unknown>>;
  }
}

function withoutBody(m: MailFull): MailSummary {
  return {
    uid: m.uid,
    messageId: m.messageId,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date,
  };
}
