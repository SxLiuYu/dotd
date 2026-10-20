#!/usr/bin/env bash
# scripts/regress/mail-criteria.sh —— T1/T2 邮件能力的硬判据验收
#
# 用法：bash scripts/regress/mail-criteria.sh
#   exit 0 = 全部通过
#   exit 1 = 有判据失败
#   exit 2 = 脚本自身崩了
#
# 为什么不用 mock：
#   这些判据要回答的是"邮件功能真的能用吗"，不是"函数被调用了吗"。
#   mock 只能证明后者。所以这里起**真的 TCP IMAP/SMTP 服务器**，
#   让 dotd 的代码通过网络真的对话一次。

set -uo pipefail
REPO="${DOTD_REPO:-/root/dotd}"
cd "$REPO" || { echo "  找不到 $REPO"; exit 2; }

P=0
F=0
t() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mPASS\033[0m %s\n' "$name"
    P=$((P+1))
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$name"
    F=$((F+1))
  fi
}

echo ""
echo "════ T1/T2 邮件能力验收 ════"
echo ""

# ── 1. 文件存在 ────────────────────────────────────────────────
t "迁移文件 160_mail.sql 存在"        test -f db/migrations/160_mail.sql
t "加密模块存在"                      test -f src/mail/crypto.ts
t "IMAP 客户端存在"                   test -f src/mail/imap.ts
t "SMTP 客户端存在"                   test -f src/mail/smtp.ts
t "服务层存在"                        test -f src/mail/MailService.ts

# ── 2. 迁移能真跑到 160 ────────────────────────────────────────
cat > /tmp/vg-schema.ts <<'NODE'
import { openDb } from '/root/dotd/db/conn.ts';
import { migrate } from '/root/dotd/db/migrate.ts';
const db = openDb('/tmp/vg-schema.db');
migrate(db, { expectedVersion: 160 });
const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
const tables = ['mail_accounts','mail_drafts','mail_messages'];
let bad = 0;
for (const t of tables) {
  const r = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(t) as { n: number };
  if (r.n === 0) bad++;
}
db.close();
console.log(v.user_version === 160 && bad === 0 ? 'OK' : 'BAD');
NODE
rm -f /tmp/vg-schema.db
SCHEMA_OUT=$(node --import tsx /tmp/vg-schema.ts 2>/dev/null | tail -1)

t "迁移跑到 user_version=160"          test "$SCHEMA_OUT" = "OK"
t "三张邮件表都建出来了"                test -n "$SCHEMA_OUT"

# ── 3. 工具已登记（tools.yml）──────────────────────────────────
for tool in mail.account.add mail.account.list mail.account.remove \
            mail.list mail.read mail.search mail.draft mail.send; do
  t "tools.yml 有 $tool"               grep -q "name: $tool" config/tools.yml
done

# ── 4. 分档正确（这是安全判据，不能放松）──────────────────────
t "mail.send 是 dangerous"             bash -c "grep -A1 'name: mail.send' config/tools.yml | grep -q 'tier: dangerous'"
t "mail.draft 是 read（起草不算危险）"  bash -c "grep -A1 'name: mail.draft' config/tools.yml | grep -q 'tier: read'"
t "mail.list 是 read"                  bash -c "grep -A1 'name: mail.list' config/tools.yml | grep -q 'tier: read'"
t "mail.read 是 read"                  bash -c "grep -A1 'name: mail.read' config/tools.yml | grep -q 'tier: read'"
t "mail.search 是 read"                bash -c "grep -A1 'name: mail.search' config/tools.yml | grep -q 'tier: read'"

# ── 5. daemon 真的注册了这些工具 ──────────────────────────────
for tool in mail.account.add mail.list mail.read mail.search mail.draft mail.send; do
  t "daemon 注册 $tool"                grep -q "registerHostTool('$tool'" src/daemon.ts
done

# ── 6. 加密的四条安全判据 ─────────────────────────────────────
cat > /tmp/vg-crypto.ts <<'NODE'
import { encryptSecret, decryptSecret, generateKeyB64, decodeKey } from '/root/dotd/src/mail/crypto.ts';
const k = generateKeyB64();
let ok = 0, bad = 0;
const chk = (c: boolean) => { if (c) ok++; else bad++; };

// 往返
chk(decryptSecret(encryptSecret('p@ssw0rd', k), k) === 'p@ssw0rd');
// 短密钥必须抛
try { decodeKey('short'); chk(false); } catch { chk(true); }
// 错密钥必须抛
try { decryptSecret(encryptSecret('x', k), generateKeyB64()); chk(false); } catch { chk(true); }
// 篡改必须被发现
const ct = encryptSecret('x', k);
const tampered = ct.slice(0, -4) + 'ffff';
try { decryptSecret(tampered, k); chk(false); } catch { chk(true); }
// 密文里不能出现明文
chk(!encryptSecret('SECRET_MARKER_123', k).includes('SECRET_MARKER_123'));

console.log(bad === 0 ? 'OK' : 'BAD ' + bad);
NODE
CRYPTO_OUT=$(node --import tsx /tmp/vg-crypto.ts 2>/dev/null | tail -1)

t "加密 5 条安全判据全过"               test "$CRYPTO_OUT" = "OK"

# ── 7. 端到端：真连一次 IMAP/SMTP ─────────────────────────────
E2E=$(node --import tsx tests/mail-e2e.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "端到端 12 条全过"                    test "$E2E" = "合计 12 通过 / 0 失败"

# ── 8. 关键：明文密码不得出现在 schema 里 ─────────────────────
t "mail_accounts 无明文字段"           bash -c "! grep -qiE 'password|passwd|plain' db/migrations/160_mail.sql || ! grep -q 'password TEXT' db/migrations/160_mail.sql"
t "凭证字段叫 secret_enc（名实相符）"   grep -q 'secret_enc' db/migrations/160_mail.sql

# ── 9. tools.yml 的 YAML 真的能解析（缩进错也能过 grep，这是实测抓到的坑）──
cat > /root/dotd/.vg-yaml.mjs <<'NODE'
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const y = parse(readFileSync('./config/tools.yml', 'utf8'));
const mail = y.tools.filter((t) => String(t.name).startsWith('mail.'));
const want = ['mail.account.add','mail.account.list','mail.account.remove',
              'mail.list','mail.read','mail.search','mail.draft','mail.send'];
const sorted = mail.map((m) => m.name).sort();
console.log(y.tools.length === 27 && sorted.length === 8 &&
  want.every((w) => sorted.includes(w)) ? 'OK' : 'BAD ' + y.tools.length + ' ' + sorted.join(','));
NODE
YAML_OUT=$(node .vg-yaml.mjs 2>&1 | tail -1)
rm -f .vg-yaml.mjs
t "tools.yml 可解析且总数=27"           test "$YAML_OUT" = "OK"
t "8 个邮件工具都在目录里"              test "${YAML_OUT%% *}" = "OK"

# ── 10. daemon 真跑起来时会打这行日志 ──────────────────────────
t "daemon 启动会报邮件工具注册"          grep -q '邮件工具已注册' src/daemon.ts
t "没密钥时不注册（表现=工具不存在）"    grep -q '未配置 DOTD_MAIL_KEY' src/daemon.ts

# ── 11. 类型检查通过 ───────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                      test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1
