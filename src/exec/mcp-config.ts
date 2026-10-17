/**
 * src/exec/mcp-config.ts —— MCP server 声明的加载（P2-1）。
 *
 * ## 文件
 * `config/mcp-servers.yml`（可用 `DOTD_MCP_CONFIG` 覆盖路径）。
 *
 * ## 形状（刻意极简，只认这几样东西）
 * ```yaml
 * servers:
 *   - name: echo
 *     command: node
 *     args: ["scripts/mcp-echo-server.mjs"]
 *     timeout_ms: 30000
 *     allow_tools: [echo, add]
 *     env:
 *       KEY: value
 * ```
 *
 * ## 为什么自己写解析
 * 仓库的 YAML 解析器住在 governance 模块里（私有函数），EX 不该反向依赖 GOV。
 * 而这里需要的语法小到不值得引任何依赖：**块列表 + 键值对 + 行内数组 + 行内映射**。
 * 解析失败一律**抛错拒启动**（与 tools.yml 同口径）——静默忽略一个写错的安全配置
 * 是这类系统里最危险的事。
 *
 * ## 默认
 * 文件不存在 / `servers: []` → **空列表 = MCP 完全关闭**。这是默认值纪律：
 * 未声明任何 server 时，工具面里不会出现 `mcp.call`。
 */

import { readFileSync } from 'node:fs';

/** 与 mcp-client.ts 的 McpServerConfig 同形（此处独立定义避免循环 import）。 */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  allowTools?: string[];
}

/** 去掉 YAML 值两端的引号与注释。 */
function cleanValue(raw: string): string {
  let v = raw.trim();
  // 行尾注释（只去未加引号时的 " #..."）
  if (!(v.startsWith('"') || v.startsWith("'"))) {
    const hash = v.indexOf(' #');
    if (hash >= 0) v = v.slice(0, hash).trim();
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** `[a, b]` → ['a','b']；`[]` → []。 */
function parseInlineList(raw: string): string[] {
  const v = cleanValue(raw);
  if (!v.startsWith('[') || !v.endsWith(']')) return [];
  const inner = v.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((x) => cleanValue(x))
    .filter((x) => x.length > 0);
}

/**
 * 解析 mcp-servers.yml 文本。
 *
 * 只支持本模块文档里写明的形状。遇到不认识的键 → **忽略**（前向兼容：
 * 将来加字段不会让老版本拒启动）；但缺 `name`/`command` → 抛错（配置写错必须见光）。
 */
export function parseMcpServersYaml(text: string): McpServerSpec[] {
  const out: McpServerSpec[] = [];
  /** 当前正在构造的 server。 */
  let cur: (McpServerSpec & { _envOpen?: boolean }) | null = null;
  /** env 块内的缩进（用于判断后续行是否仍属 env）。 */
  let envIndent = -1;

  const flush = (): void => {
    if (cur === null) return;
    const { _envOpen, ...spec } = cur;
    void _envOpen;
    if (spec.name.length === 0) {
      throw new Error('mcp-servers.yml：某个 server 缺 name');
    }
    if (spec.command.length === 0) {
      throw new Error(`mcp-servers.yml：server ${spec.name} 缺 command`);
    }
    out.push(spec);
    cur = null;
    envIndent = -1;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    // 顶层 servers:
    if (indent === 0) {
      if (/^servers\s*:/.test(trimmed)) {
        const inline = trimmed.slice(trimmed.indexOf(':') + 1).trim();
        // `servers: []` → 显式空
        if (inline === '[]') return [];
        continue;
      }
      // 顶层其他键：忽略（前向兼容）
      continue;
    }

    // 列表项 `- name: x` 或 `-` 后接续行
    if (trimmed.startsWith('- ')) {
      flush();
      cur = { name: '', command: '', args: [] };
      envIndent = -1;
      const rest = trimmed.slice(2).trim();
      applyKeyValue(cur, rest);
      continue;
    }
    if (trimmed === '-') {
      flush();
      cur = { name: '', command: '', args: [] };
      envIndent = -1;
      continue;
    }
    if (cur === null) continue;

    // env 块内的键值（比 env: 更深缩进）
    if (envIndent >= 0 && indent > envIndent) {
      const colon = trimmed.indexOf(':');
      if (colon > 0) {
        const k = trimmed.slice(0, colon).trim();
        const v = cleanValue(trimmed.slice(colon + 1));
        cur.env = cur.env ?? {};
        cur.env[k] = v;
      }
      continue;
    }
    envIndent = -1;

    // 普通键值
    if (applyKeyValue(cur, trimmed, () => indent)) {
      if (/^env\s*:/.test(trimmed)) envIndent = indent;
    }
  }
  flush();
  return out;
}

/** 把一个 `key: value` 应用到 spec；返回是否命中 env 键（用于跟踪缩进）。 */
function applyKeyValue(
  spec: McpServerSpec & { _envOpen?: boolean },
  line: string,
  indentOf?: () => number,
): boolean {
  const colon = line.indexOf(':');
  if (colon <= 0) return false;
  const key = line.slice(0, colon).trim();
  const rawVal = line.slice(colon + 1).trim();
  switch (key) {
    case 'name':
      spec.name = cleanValue(rawVal);
      return false;
    case 'command':
      spec.command = cleanValue(rawVal);
      return false;
    case 'args':
      spec.args = parseInlineList(rawVal);
      return false;
    case 'timeout_ms': {
      const n = Number(cleanValue(rawVal));
      if (Number.isFinite(n) && n > 0) spec.timeoutMs = Math.floor(n);
      return false;
    }
    case 'allow_tools':
      spec.allowTools = parseInlineList(rawVal);
      return false;
    case 'env': {
      if (rawVal.length > 0) {
        // 行内映射 `{ KEY: value }`
        const inner = cleanValue(rawVal);
        if (inner.startsWith('{') && inner.endsWith('}')) {
          const env: Record<string, string> = {};
          for (const pair of inner.slice(1, -1).split(',')) {
            const c = pair.indexOf(':');
            if (c > 0) env[pair.slice(0, c).trim()] = cleanValue(pair.slice(c + 1));
          }
          spec.env = env;
        }
      }
      void indentOf;
      return true; // env 块开始
    }
    default:
      return false; // 未知键：前向兼容忽略
  }
}

/**
 * 从文件加载（缺文件 = 空列表 = 关闭）。
 *
 * @throws 解析失败/配置不合法时抛错 —— 装配层据此**拒启动**（静默忽略安全配置最危险）。
 */
export function loadMcpServers(path: string): McpServerSpec[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // 文件不存在 = 未声明 = 关闭
  }
  try {
    return parseMcpServersYaml(text);
  } catch (err) {
    throw new Error(`MCP 配置解析失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
}
