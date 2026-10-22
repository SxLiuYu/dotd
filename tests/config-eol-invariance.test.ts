/**
 * tests/config-eol-invariance.test.ts —— 配置解析必须与行尾无关（CRLF / LF 同结果）。
 *
 * 为什么单独一个文件：2026-10-22 实测发现 `parseModelsYaml` 用 `text.split('\n')` 切行，
 * 而 Windows 工作区（core.autocrlf=true）检出的 config/models.yml 是 CRLF —— 每行末尾
 * 留着 '\r'，缩进判断 / `# 注释`剥离 / `key: value` 取值全部失真，**整份配置解析成 0 个端点**，
 * daemon 启动即抛「models.yml 未定义任何端点」拒启动。同一份文件在 WSL（LF）下全绿，
 * 所以这个 bug 在 Linux CI 上永远不会暴露。
 *
 * 这一类问题（手写行解析器 + 平台行尾）不能靠"记得小心"来防。这里把仓库自带的**真实
 * 配置文件**各解析两遍（强制 CRLF / 强制 LF），断言结果完全相同：任何一处解析器回归，
 * 这条测试立刻红，而且报错会直接指出是哪份配置。
 *
 * 已验证覆盖的入口（2026-10-22 逐个实地探测，全部通过）：
 *   models.yml        → parseModelsYaml          （修前 CRLF 致命，已修）
 *   free-models.yml   → parseFreeModelsYaml      （修前 CRLF 致命，已修）
 *   tools.yml         → loadCatalogFile          （本就安全：走 yaml 库）
 *   rules.yml         → loadRulesFile            （本就安全）
 *   dotd.yml          → loadSurfacesConfig       （本就安全：split(/\r?\n/)）
 *   event-rules.yml   → parseEventRules          （本就安全：split(/\r?\n/)）
 *   mcp-servers.yml   → parseMcpServersYaml      （本就安全：split(/\r?\n/)）
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, before, after } from 'node:test';

import { parseModelsYaml } from '../src/router/config.ts';
import { parseFreeModelsYaml } from '../src/router/pool.ts';
import { loadCatalogFile, loadRulesFile } from '../src/governance/catalog.ts';
import { loadSurfacesConfig } from '../src/surfaces/config.ts';
import { parseEventRules } from '../src/event-rules.ts';
import { parseMcpServersYaml } from '../src/exec/mcp-config.ts';

const CONFIG_DIR = resolve(import.meta.dirname, '..', 'config');

/** 强制成 CRLF（先归一到 LF，避免混合行尾干扰判定）。 */
function toCrlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}
/** 强制成 LF。 */
function toLf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** 把 Map 及其它特殊值转成可深比较的普通结构。 */
function plain(v: unknown): unknown {
  if (v instanceof Map) {
    return Object.fromEntries([...v.entries()].map(([k, x]) => [k, plain(x)]));
  }
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dotd-eol-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 读真实配置并同时给出 CRLF / LF 两个临时副本路径。 */
function writePair(name: string): { lf: string; crlf: string; raw: string } {
  const raw = readFileSync(join(CONFIG_DIR, name), 'utf8');
  const lfPath = join(tmp, name + '.lf');
  const crlfPath = join(tmp, name + '.crlf');
  writeFileSync(lfPath, toLf(raw), 'utf8');
  writeFileSync(crlfPath, toCrlf(raw), 'utf8');
  return { lf: lfPath, crlf: crlfPath, raw };
}

describe('配置解析与行尾无关（CRLF / LF 必须同结果）', () => {
  it('前置：样本确实各自是纯 CRLF / 纯 LF（否则本文件在空转）', () => {
    const p = writePair('models.yml');
    assert.equal(readFileSync(p.lf, 'utf8').includes('\r'), false, 'LF 副本不该有 \\r');
    assert.ok(readFileSync(p.crlf, 'utf8').includes('\r\n'), 'CRLF 副本必须是 CRLF');
  });

  it('models.yml：端点/主模型/续行列表在 CRLF 下不得丢失（修前解析成 0 端点）', () => {
    const p = writePair('models.yml');
    const lf = parseModelsYaml(readFileSync(p.lf, 'utf8'));
    const crlf = parseModelsYaml(readFileSync(p.crlf, 'utf8'));
    // 硬断言先证明"CRLF 没被解析成空" —— 否则两边一起错时 deepEqual 会放行
    assert.ok(lf.endpoints.length > 0, 'LF 端点不能是 0 个');
    assert.ok(crlf.endpoints.length > 0, 'CRLF 端点不能是 0 个（修前就是 0，这是本用例的存在理由）');
    assert.equal(crlf.endpoints.length, lf.endpoints.length, '两种行尾端点数量必须一致');
    assert.ok(!crlf.recon.sources.length === false, 'recon.sources 必须在 CRLF 下也解析出来');
    assert.equal(crlf.routing.light_events.length, lf.routing.light_events.length, '续行列表不能被 CRLF 吞掉');
    assert.deepEqual(plain(crlf), plain(lf), '整份配置必须逐字段相同');
    // 值里残留 \\r 是这类 bug 最直接的指纹
    for (const ep of crlf.endpoints) {
      if (ep.apiKeyEnv !== null) assert.equal(ep.apiKeyEnv, ep.apiKeyEnv.trim(), 'apiKeyEnv 不能带尾随空白');
      assert.equal(ep.baseUrl, ep.baseUrl.trim(), 'baseUrl 不能带尾随空白');
    }
  });

  it('free-models.yml：条目与 updated_at 在 CRLF 下不得失真', () => {
    const p = writePair('free-models.yml');
    const lf = parseFreeModelsYaml(readFileSync(p.lf, 'utf8'));
    const crlf = parseFreeModelsYaml(readFileSync(p.crlf, 'utf8'));
    assert.deepEqual(plain(crlf), plain(lf));
    assert.equal(crlf.version, lf.version, 'version 必须一致');
  });

  it('tools.yml：45 个工具白名单不得因 CRLF 掉成空（治理 fail-closed 的底线）', () => {
    const p = writePair('tools.yml');
    const lf = loadCatalogFile(p.lf).catalog;
    const crlf = loadCatalogFile(p.crlf).catalog;
    assert.ok(lf.tools.size > 0, 'LF 工具数不能是 0');
    assert.equal(crlf.tools.size, lf.tools.size, '工具数必须一致（CRLF 掉成 0 = 全部工具被 deny）');
    // 档位是最要命的一列：dangerous 掉了 = 危险工具被当只读放行
    for (const [name, def] of lf.tools) {
      assert.equal(crlf.tools.get(name)?.tier, def.tier, `工具 ${name} 的档位在 CRLF 下必须一致`);
    }
    assert.equal(lf.tools.get('fs.remove')?.tier, 'dangerous', 'fs.remove 必须是 dangerous（防绕过审批）');
  });

  it('rules.yml：收紧规则在 CRLF 下不得被静默丢弃', () => {
    const p = writePair('rules.yml');
    const cat = loadCatalogFile(join(CONFIG_DIR, 'tools.yml')).catalog;
    const lf = loadRulesFile(p.lf, cat);
    const crlf = loadRulesFile(p.crlf, cat);
    assert.equal(crlf.catalog.rules.length, lf.catalog.rules.length, '生效规则数必须一致');
    assert.deepEqual(plain(crlf.catalog.rules), plain(lf.catalog.rules));
  });

  it('event-rules.yml：事件规则条数在 CRLF 下必须一致', () => {
    const p = writePair('event-rules.yml');
    const lf = parseEventRules(readFileSync(p.lf, 'utf8'));
    const crlf = parseEventRules(readFileSync(p.crlf, 'utf8'));
    assert.equal(crlf.length, lf.length, '规则条数必须一致');
    assert.deepEqual(plain(crlf), plain(lf));
  });

  it('mcp-servers.yml：声明条目在 CRLF 下必须一致（默认空也要一致）', () => {
    const p = writePair('mcp-servers.yml');
    const lf = parseMcpServersYaml(readFileSync(p.lf, 'utf8'));
    const crlf = parseMcpServersYaml(readFileSync(p.crlf, 'utf8'));
    assert.deepEqual(plain(crlf), plain(lf));
  });

  it('dotd.yml：surfaces 各节结构与取值在 CRLF 下必须一致', () => {
    const p = writePair('dotd.yml');
    // 真实配置用 ${ENV} 占位，解析前必须能把它们展开；给全假值即可（只看结构）
    const raw = readFileSync(p.lf, 'utf8');
    const vars = [...new Set([...raw.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)].map((m) => m[1] as string))];
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) {
      saved[v] = process.env[v];
      if (process.env[v] === undefined) process.env[v] = 'eol-probe-' + v.toLowerCase();
    }
    try {
      const lf = loadSurfacesConfig(p.lf);
      const crlf = loadSurfacesConfig(p.crlf);
      assert.deepEqual(plain(crlf), plain(lf), '整份 surfaces 配置必须逐字段相同');
      // 断言"确实解析出了内容"，防两边一起空时 deepEqual 放行。
      // 注意：不写死具体节名 —— 表面配置会新增节（brief / connWatch 等），
      // 这里只要求"每一节都非空"，新增节自动被覆盖，不需要改测试。
      const lfPlain = plain(lf) as Record<string, unknown>;
      const crlfPlain = plain(crlf) as Record<string, unknown>;
      const keys = Object.keys(lfPlain);
      assert.ok(keys.length > 0, 'surfaces 配置不能解析成空对象');
      assert.deepEqual(Object.keys(crlfPlain).sort(), keys.sort(), '两种行尾解析出的节名集合必须相同');
      for (const k of keys) {
        const v = lfPlain[k];
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          assert.ok(Object.keys(v as Record<string, unknown>).length > 0, `surfaces.${k} 不能是空节`);
        }
      }
      // 取值级断言：http.masterToken 是 fail-closed 判据（空串 = 谁都能以主人身份操作），
      // 若值尾残留 \r，trim 后的比较会暴露出来。
      assert.ok(crlf.http.masterToken.length > 0, 'http.masterToken 展开后不能为空');
      assert.equal(crlf.http.masterToken, crlf.http.masterToken.trim(), 'masterToken 不能带尾随空白');
      assert.equal(crlf.http.port, lf.http.port, 'http.port 必须一致');
    } finally {
      for (const v of vars) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v];
      }
    }
  });
});
