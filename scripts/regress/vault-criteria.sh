#!/usr/bin/env bash
# scripts/regress/vault-criteria.sh —— A2 密码保险库判据（exit 0 = 过）。
# 覆盖：往返 / 静止即密文 / 缺条目 fail-closed / 替换+清洗 / list 不带值。
set -euo pipefail
cd "$(dirname "$0")/../.."

TMP="$(mktemp -d /tmp/dotd-vault-crit-XXXXXX)"
KEY="$(node --import tsx -e 'process.stdout.write(Buffer.alloc(32, 13).toString("base64"))')"
trap 'rm -rf "$TMP"' EXIT
FAIL=""

# ① 写入→读取往返 + 文件无明文
SECRET="crit-secret-$(date +%s)-XyZ"
node --import tsx -e '
const { vaultPut } = await import("./src/vault/vault.ts");
vaultPut(process.argv[1], process.argv[2], "crit.example", "u", process.argv[3]);
' "$TMP" "$KEY" "$SECRET"
grep -q "$SECRET" "$TMP/vault.json" && FAIL="$FAIL ①文件含明文" || echo "  ① vault.json 无明文 OK"
GOT="$(node --import tsx -e '
const { vaultGet } = await import("./src/vault/vault.ts");
process.stdout.write(vaultGet(process.argv[1], process.argv[2], "crit.example", "u") ?? "NULL");
' "$TMP" "$KEY")"
[ "$GOT" = "$SECRET" ] && echo "  ① 往返 OK" || FAIL="$FAIL ①往返"

# ② list 只有 site/user
LIST="$(node --import tsx -e '
const { vaultList } = await import("./src/vault/vault.ts");
process.stdout.write(JSON.stringify(vaultList(process.argv[1])));
' "$TMP")"
[ "$LIST" = '[{"site":"crit.example","user":"u"}]' ] && echo "  ② list 形状 OK" || FAIL="$FAIL ②list($LIST)"

# ③ 占位符替换 + 回包清洗（substitute 层）
node --import tsx -e '
const { substituteVaultArgs, scrubSecrets } = await import("./src/vault/substitute.ts");
const out = substituteVaultArgs({ a: { p: "$vault:crit.example:u" } }, (s, u) =>
  s === "crit.example" && u === "u" ? process.argv[1] : null);
if (out.args.a.p !== process.argv[1]) process.exit(3);
const scr = scrubSecrets({ v: process.argv[1] }, out.secrets);
if (JSON.stringify(scr).includes(process.argv[1])) process.exit(4);
' "$SECRET" && echo "  ③ 替换+清洗 OK" || FAIL="$FAIL ③替换清洗"

# ④ 缺条目 → null（fail-closed 上游报 vault_missing）
MISS="$(node --import tsx -e '
const { vaultGet } = await import("./src/vault/vault.ts");
process.stdout.write(vaultGet(process.argv[1], process.argv[2], "nope", "u") ?? "NULL");
' "$TMP" "$KEY")"
[ "$MISS" = "NULL" ] && echo "  ④ 缺条目 fail-closed OK" || FAIL="$FAIL ④缺条目"

# ⑤ exec 集成（真 ExecServiceImpl）
node --import tsx --test tests/exec-vault.test.ts tests/vault.test.ts >"$TMP/suite.txt" 2>&1 \
  && echo "  ⑤ vault 单测+exec 集成 OK" || { FAIL="$FAIL ⑤单测"; tail -20 "$TMP/suite.txt"; }

# ⑥ 五层接线（目录/白名单/注册/ToolDoc/tools.yml）
for pat in "name: 'vault.sites'" ; do
  grep -qF "$pat" src/exec/protocol.ts && grep -qF "$pat" src/runner/tool-catalog.ts \
    || FAIL="$FAIL ⑥目录缺$pat"
done
grep -qF "'vault.sites'" src/exec/ExecService.ts || FAIL="$FAIL ⑥白名单"
grep -qF "registerHostTool('vault.sites'" src/daemon.ts || FAIL="$FAIL ⑥注册"
grep -qF "name: vault.sites" config/tools.yml || FAIL="$FAIL ⑥tools.yml"
[ -z "$FAIL" ] && echo "  ⑥ 五层接线 OK" || true

echo "  ═══════════════════════"
if [ -n "$FAIL" ]; then echo "FAIL:$FAIL"; exit 1; fi
echo "PASS: vault-criteria 全过（6/6）"
