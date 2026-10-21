/**
 * src/connectors/registry.ts —— 连接器目录（第一批：github / rss）。
 *
 * 职责：只做「有哪些连接器、各自处于什么状态」的**只读目录**，不含任何网络调用。
 * status 由凭证/环境自动判定，不是人手配置的布尔位：
 *   - github：环境变量 DOTD_GITHUB_TOKEN 存在 → 'connected'；缺失 → 'public-only'
 *     （未认证公开 API 限速 60 请求/h，issues/pulls 仍可用，notifications 不可用）。
 *   - rss：无凭证概念，始终 'ready'。
 *
 * 为什么 status 收在目录里而不是散在各连接器内部：调用方（daemon / 工具层）拿到一份
 * 目录就能决定暴露哪些工具、要不要提示「先配 token」，不必逐个探测。
 *
 * env 作为参数注入（默认 process.env）：状态判定可测，测试不必去改全局环境。
 */

/** 连接器状态词表。 */
export type ConnectorStatus = 'connected' | 'public-only' | 'ready';

/** 连接器目录条目。 */
export interface ConnectorInfo {
  /** 稳定 id；工具命名空间前缀（github.* / rss.*）从这里来。 */
  id: string;
  name: string;
  desc: string;
  status: ConnectorStatus;
}

/** GitHub token 的环境变量名。 */
export const GITHUB_TOKEN_ENV = 'DOTD_GITHUB_TOKEN';

/** 当前连接器目录（顺序即展示顺序）。 */
export function connectorCatalog(env: NodeJS.ProcessEnv = process.env): ConnectorInfo[] {
  const token = env[GITHUB_TOKEN_ENV];
  const hasToken = typeof token === 'string' && token.length > 0;
  return [
    {
      id: 'github',
      name: 'GitHub',
      desc: hasToken
        ? '通知 / Issues / Pulls（认证 API，5000 请求/小时）'
        : 'Issues / Pulls（未认证公开 API，限速 60 请求/小时）；notifications 需要认证',
      status: hasToken ? 'connected' : 'public-only',
    },
    {
      id: 'rss',
      name: 'RSS/Atom 订阅',
      desc: '拉取 RSS 2.0 / Atom 源并解析为条目（无凭证概念）',
      status: 'ready',
    },
  ];
}

/** 按 id 取单个连接器；未知 id 返回 null。 */
export function getConnector(id: string, env: NodeJS.ProcessEnv = process.env): ConnectorInfo | null {
  return connectorCatalog(env).find((c) => c.id === id) ?? null;
}