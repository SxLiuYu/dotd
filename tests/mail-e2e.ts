/**
 * tests/mail-e2e.ts —— 邮件能力的端到端验证（T1，2026-10-20）
 *
 * 为什么不用 mock：
 *   我要证明的不是"函数被调用了"，而是"IMAP 协议真的能对话"。
 *   mock 能证明前者，证明不了后者 —— 而后者才是会坏的地方
 *   （字面量读取、多行响应、CRLF 处理，每一条都踩过坑）。
 *
 * 做法：起一个**真的 TCP IMAP 服务器**（本地 127.0.0.1），
 *   握手、LOGIN、SELECT、FETCH、SEARCH 全部按 RFC 3501 应答。
 *   然后让 imap.ts 连上去，验证它拿到的数据对不对。
 *
 * 同理起一个 SMTP 服务器验证发信（含 AUTH LOGIN 全流程）。
 */
import { createServer as createTcpServer, type Socket } from 'node:net';
import { ImapClient } from '../src/mail/imap.ts';
import { sendMail } from '../src/mail/smtp.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
};

// ── 假 IMAP 服务器 ────────────────────────────────────────────────
const MAIL_RAW =
  'From: laowang@example.com\r\n' +
  'To: me@example.com\r\n' +
  'Subject: =?utf-8?B?5rWL6K+V5Li76aKY?=\r\n' + // "测试主题"
  'Date: Mon, 20 Oct 2026 10:00:00 +0800\r\n' +
  'Message-ID: <abc123@example.com>\r\n' +
  'Content-Type: multipart/mixed; boundary="BND"\r\n' +
  '\r\n' +
  '--BND\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  '\r\n' +
  '这是正文，包含关键词：报价单。\r\n' +
  '--BND\r\n' +
  'Content-Type: application/pdf; name="quote.pdf"\r\n' +
  'Content-Disposition: attachment; filename="quote.pdf"\r\n' +
  '\r\n' +
  'JVBERi0xLjQK\r\n' +
  '--BND--\r\n';

const imapServer = createTcpServer((sock: Socket) => {
  let buf = '';
  let authed = false;
  sock.write('* OK fake IMAP ready\r\n');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    for (;;) {
      const i = buf.indexOf('\r\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const tag = line.split(' ')[0] ?? '';
      const cmd = line.slice(tag.length + 1).toUpperCase();
      if (cmd.startsWith('LOGIN')) {
        // 验证密码确实是明文传进来的（TLS 层负责保护，这里只验证协议）
        authed = line.includes('secret123');
        sock.write(tag + (authed ? ' OK LOGIN done\r\n' : ' NO bad creds\r\n'));
      } else if (cmd.startsWith('SELECT')) {
        sock.write('* 3 EXISTS\r\n');
        sock.write(tag + ' OK SELECT done\r\n');
      } else if (cmd.startsWith('SEARCH')) {
        sock.write('* SEARCH 2\r\n');
        sock.write(tag + ' OK SEARCH done\r\n');
      } else if (cmd.startsWith('UID FETCH') || cmd.startsWith('FETCH')) {
        // 关键：字面量形式 {N}\r\n<恰好 N 字节>
        const b = Buffer.from(MAIL_RAW, 'utf8');
        sock.write('* 1 FETCH (UID 2 BODY[] {' + b.length + '}\r\n');
        sock.write(b);
        sock.write(')\r\n');
        sock.write(tag + ' OK FETCH done\r\n');
      } else if (cmd.startsWith('LOGOUT')) {
        sock.write('* BYE\r\n');
        sock.write(tag + ' OK LOGOUT done\r\n');
        sock.end();
      } else if (cmd.startsWith('CAPABILITY')) {
        sock.write('* CAPABILITY IMAP4rev1\r\n');
        sock.write(tag + ' OK done\r\n');
      } else {
        sock.write(tag + ' OK done\r\n');
      }
    }
  });
  sock.on('error', () => {});
});

// ── 假 SMTP 服务器 ────────────────────────────────────────────────
const smtpServer = createTcpServer((sock: Socket) => {
  let buf = '';
  let stage = 'greet';
  let data = '';
  sock.write('220 fake SMTP ready\r\n');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    for (;;) {
      if (stage === 'data') {
        // DATA 阶段：等到单独一个 . 为止
        if (!buf.includes('\r\n.\r\n')) break;
        const idx = buf.indexOf('\r\n.\r\n');
        data += buf.slice(0, idx);
        buf = buf.slice(idx + 5);
        sock.write('250 OK queued\r\n');
        stage = 'done';
        continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) {
        sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
      } else if (up === 'AUTH LOGIN') {
        sock.write('334 VXNlcm5hbWU6\r\n');
        stage = 'user';
      } else if (stage === 'user') {
        sock.write('334 UGFzc3dvcmQ6\r\n');
        stage = 'pass';
      } else if (stage === 'pass') {
        sock.write('235 auth ok\r\n');
        stage = 'ok';
      } else if (up.startsWith('MAIL FROM')) {
        sock.write('250 OK\r\n');
      } else if (up.startsWith('RCPT TO')) {
        sock.write('250 OK\r\n');
      } else if (up === 'DATA') {
        sock.write('354 go ahead\r\n');
        stage = 'data';
      } else if (up === 'QUIT') {
        sock.write('221 bye\r\n');
        sock.end();
      } else {
        sock.write('250 OK\r\n');
      }
    }
  });
  sock.on('error', () => {});
  // 把收到的 DATA 暴露出去给断言用
  (sock as unknown as { __data: () => string }).__data = () => data;
});

async function listen(s: ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((res) => {
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      res(typeof a === 'object' && a ? a.port : 0);
    });
  });
}

const main = async () => {
  const imapPort = await listen(imapServer);
  const smtpPort = await listen(smtpServer);
  console.log('\n  [假 IMAP :' + imapPort + '  假 SMTP :' + smtpPort + ']\n');

  // ── IMAP 测试 ──
  {
    const c = await ImapClient.open({
      host: '127.0.0.1',
      port: imapPort,
      user: 'me@example.com',
      pass: 'secret123',
      __insecurePlainForTest: true,
    });
    ok('IMAP 握手+登录', true);

    const n = await c.select('INBOX');
    ok('SELECT 读到邮件数', n === 3, '实际 ' + n);

    const full = await c.fetchByUid('2');
    ok('FETCH 拿到邮件', full !== null);
    ok('  正文正确', !!full && full.bodyText.includes('报价单'), full ? '长度 ' + full.bodyText.length : '');
    ok('  附件名解析', !!full && full.attachmentNames.includes('quote.pdf'), JSON.stringify(full?.attachmentNames));
    ok('  中文主题解码', !!full && full.subject === '测试主题', JSON.stringify(full?.subject));
    ok('  Message-ID', !!full && full.messageId === '<abc123@example.com>', String(full?.messageId));

    const uids = await c.search('报价单');
    ok('SEARCH 返回 UID', uids.length === 1 && uids[0] === '2', JSON.stringify(uids));

    await c.close();
    ok('LOGOUT 正常关闭', true);
  }

  // ── 错误密码 ──
  {
    let threw = false;
    try {
      await ImapClient.open({ host: '127.0.0.1', port: imapPort, user: 'x', pass: 'wrong', __insecurePlainForTest: true });
    } catch {
      threw = true;
    }
    ok('错密码被拒（不静默成功）', threw);
  }

  // ── SMTP 测试 ──
  {
    const mid = await sendMail(
      { host: '127.0.0.1', port: smtpPort, user: 'me@example.com', pass: 'secret123', __insecurePlainForTest: true },
      {
        from: 'me@example.com',
        to: ['laowang@example.com'],
        subject: '回复：报价单',
        body: '收到了，谢谢。',
        inReplyTo: '<abc123@example.com>',
      },
    );
    ok('SMTP 发送成功', mid.length > 10, mid);
  }

  // ── 连接失败要报错，不能假装成功 ──
  {
    let threw = false;
    try {
      await sendMail({ host: '127.0.0.1', port: 1, user: 'a', pass: 'b' }, {
        from: 'a@b.c', to: ['d@e.f'], subject: 'x', body: 'y',
      });
    } catch {
      threw = true;
    }
    ok('连不上时抛错（不假装成功）', threw);
  }

  imapServer.close();
  smtpServer.close();

  console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('  崩了：', e);
  process.exit(2);
});
