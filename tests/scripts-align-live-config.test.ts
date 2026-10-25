/**
 * tests/scripts-align-live-config.test.ts —— live 配置对齐脚本的纯函数回归。
 *
 * 背景（2026-10-17 全方位测试高危"配置漂移炸弹"）：live ~/.dotd/config.yml 的
 * 端口停在 7789、telegram 段还在、expected_user_version 停在 50，而仓库模板与
 * src/daemon.ts 早就走到 7788/退役/90。两边没有同步机制，日志里也看不出异常。
 * align-live-config.mjs 负责把 live 逐行掰回来（不覆盖整份文件，live 里有
 * ${VAR} 引用和运维手改注释）。
 *
 * 这里只测纯函数 alignConfigText：键路径作用域、注释与 ${VAR} 保留、幂等。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignConfigText, migrationsMax } from '../scripts/align-live-config.mts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LIVE = `# 头部注释：不要动
version: 1
data_dir: ~/.dotd
dotdReserveMb: 6144

db:
  path: \${DOTD_DB_PATH}
  expected_user_version: 50

surfaces:
  http:
    host: 127.0.0.1
    port: 7789
    master_token: "\${DOTD_MASTER_TOKEN}"
    readonly_tokens: ["\${DOTD_RO_TOKEN}"]
    allowed_origins: ["http://localhost:7788", "http://127.0.0.1:7788"]
  telegram:
    bot_token: "\${TG_BOT_TOKEN}"
    allowlist: [123456789]
    edit_throttle_ms: 1200
  feishu:
    app_id: "\${FEISHU_APP_ID}"
    owner_chat_id: "\${FEISHU_OWNER_CHAT_ID}"
    edit_throttle_ms: 1200
  ui:
    stream_deltas: true
`;

describe('align-live-config', () => {
  it('一次对齐三处漂移：端口 7789→7788、删 telegram 段、expected_user_version 50→212', () => {
    // 版本号不再写死 90（那是"每次部署都把注记改成旧错"的源头），
    // 缺省从 db/migrations 的最大 NNN 推导 —— 当前是 212。
    const { text, changes } = alignConfigText(LIVE);
    assert.equal(changes.length, 3, `改动应是三处，实际：${changes.join(' | ')}`);
    assert.match(changes[0]!, /expected_user_version 50 → 212/);
    assert.match(changes[1]!, /端口 7789 → 7788/);
    assert.match(changes[2]!, /surfaces\.telegram 段/);

    assert.match(text, /^    port: 7788$/m);
    assert.match(text, /^  expected_user_version: 212$/m);
    assert.doesNotMatch(text, /telegram:/);
    assert.doesNotMatch(text, /TG_BOT_TOKEN/);
  });

  it('${VAR} 引用与注释逐字保留（不覆盖整份文件的代价就在这里）', () => {
    const { text } = alignConfigText(LIVE);
    assert.ok(text.startsWith('# 头部注释：不要动\n'), '头部注释必须在');
    for (const needle of [
      '${DOTD_DB_PATH}',
      '${DOTD_MASTER_TOKEN}',
      '${DOTD_RO_TOKEN}',
      '${FEISHU_APP_ID}',
      '${FEISHU_OWNER_CHAT_ID}',
      'allowed_origins: ["http://localhost:7788", "http://127.0.0.1:7788"]',
      'edit_throttle_ms: 1200',
      'stream_deltas: true',
    ]) {
      assert.ok(text.includes(needle), `应保留：${needle}`);
    }
  });

  it('幂等：对齐后再跑一次零改动', () => {
    const once = alignConfigText(LIVE).text;
    const twice = alignConfigText(once);
    assert.equal(twice.changes.length, 0);
    assert.equal(twice.text, once, '第二次必须逐字节相同');
  });

  it('已对齐的输入原样返回', () => {
    const { text, changes } = alignConfigText(LIVE);
    const again = alignConfigText(text);
    assert.deepEqual(again.changes, []);
    assert.equal(again.text, text);
  });

  it('键路径作用域：别的节里的 port / expected_user_version 不误伤', () => {
    const src = `surfaces:
  http:
    port: 7789
  ui:
    port: 3000
exec:
  runtime:
    port: 9223
db:
  expected_user_version: 50
other:
  expected_user_version: 12
`;
    const { text, changes } = alignConfigText(src);
    assert.equal(changes.length, 2, `只该改两处，实际：${changes.join(' | ')}`);
    assert.match(text, /^  http:\n    port: 7788$/m);
    assert.match(text, /port: 3000/, 'ui.port 不是 HTTP 监听端口，不能动');
    assert.match(text, /port: 9223/, 'exec.runtime.port 是容器运行时端口，不能动');
    assert.match(text, /^  expected_user_version: 212$/m);
    assert.match(text, /expected_user_version: 12/, '非 db 节的同名列不能动');
  });

  it('telegram 段在文件末尾也能整段删除（含尾部空行不吞掉后续内容）', () => {
    const src = `surfaces:
  http:
    port: 7788
  telegram:
    bot_token: "x"
    allowlist: [1]
`;
    const { text, changes } = alignConfigText(src);
    assert.equal(changes.length, 1);
    assert.ok(!text.includes('telegram'), `telegram 必须删干净：\n${text}`);
    assert.equal(text.trimEnd(), 'surfaces:\n  http:\n    port: 7788'.trimEnd());
  });

  it('CRLF 文件保持 CRLF（不悄悄换行尾）', () => {
    const src = 'db:\r\n  expected_user_version: 50\r\nsurfaces:\r\n  http:\r\n    port: 7789\r\n';
    const { text } = alignConfigText(src);
    assert.ok(text.includes('\r\n'), '行尾必须是 CRLF');
    assert.ok(!/(?<!\r)\n/.test(text), '不允许混进裸 LF');
  });

  it('没有 telegram 段时也能单独修端口（退役段是可选项不是必选项）', () => {
    const { text, changes } = alignConfigText('surfaces:\n  http:\n    port: 9000\n');
    assert.equal(changes.length, 1);
    assert.match(text, /port: 7788/);
  });

  // 2026-10-26：这一行以前写死 90，而 src/daemon.ts 里是 212、db/migrations 最大也是 212。
  // 于是**每次部署**都热情地把 live 配置从 50 改成 90 —— 把一份本来就错的东西
  // 从旧错改成新错，还写进备份目录。判据改成"从 migrations 推导"，这两条钉住它。
  it('期望版本从 db/migrations 推导，不写死（当前 212）', () => {
    assert.equal(migrationsMax(repoRoot), '212');
    const { text } = alignConfigText('db:\n  expected_user_version: 50\n');
    assert.match(text, /expected_user_version: 212/);
  });

  it('推导不出目标版本时不动这一行（不编数字）', () => {
    // null = "推导不出来"：读不到 migrations 就不改，留着旧值比写个假的好。
    const { text, changes } = alignConfigText('db:\n  expected_user_version: 50\n', { version: null });
    assert.equal(changes.length, 0);
    assert.match(text, /expected_user_version: 50/);
  });
});
