/**
 * src/connectors/rss.ts —— RSS 2.0 / Atom 订阅连接器（第一批）。
 *
 * fetchFeed(url) → 成功 {ok:true, title, items:[{title, link, published, text}]}；
 * 失败折叠成 {ok:false, error} **永不抛**（与 github.ts 同一纪律）。
 *
 * XML 是手写解析（零依赖铁律：不引任何 XML 库）。容错档位刻意定在「够用的最低线」：
 *   - 命名空间前缀：按 local name 匹配（content:encoded ↔ encoded、dc:date ↔ date）；
 *   - CDATA：按原文收进文本；
 *   - HTML 基本实体：&amp; &lt; &gt; &quot; &apos; &nbsp; 与数字（&#39; / &#x27;），
 *     连续转义逐层解（≤3 层，覆盖 type="html" 的 XML+HTML 双层转义）；
 *   - Atom link 在 href 属性上（RSS 在 <link> 文本里）——两处都收；
 *   - 去重键 = link（同一链接只保留先到的一条；无 link 的条目不去重、原样保留）。
 *
 * 明确不做：命名空间语义校验、完整 DOM、XSL、media:/itunes: 等扩展。
 * 文本清洗的两条管线（实测两种编码形态都要照顾）：
 *   - 标题/链接/日期 plain()：先剥真实标签再解实体 —— 保留 "Second &lt;update&gt;" 解出来的尖括号字面量；
 *   - 正文 asText()：先解实体再剥标签 —— CDATA 包 HTML 与 &lt;p&gt; 转义 HTML 两种常见形态都变成纯文本。
 */

export const RSS_TIMEOUT_MS = 15_000;

export interface FeedItem {
  title: string;
  link: string;
  /** 原样保留源里的时间串（RSS 是 RFC 822，Atom 是 ISO 8601），不解析不换算。缺则 null。 */
  published: string | null;
  /** 摘要/正文纯文本（已去 HTML 标签、解实体、折叠空白）。 */
  text: string;
}

export interface FeedResult {
  ok: boolean;
  /** feed 标题。 */
  title?: string;
  /** 条目（已按 link 去重）。 */
  items?: FeedItem[];
  /** 失败时的结构化原因：timeout / network / http_NNN / bad_xml。 */
  error?: string;
  status?: number;
}

/** 拉取并解析一个 RSS 2.0 / Atom 源。 */
export async function fetchFeed(url: string, opts: { timeoutMs?: number } = {}): Promise<FeedResult> {
  const timeoutMs = opts.timeoutMs ?? RSS_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': 'dotd-connector',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: `timeout: 抓取 ${timeoutMs}ms 超时（${msg}）` };
    }
    return { ok: false, error: `network: ${msg}` };
  }
  const status = res.status;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = body.length > 0 ? ` ${body.slice(0, 200)}` : '';
    return { ok: false, status, error: `http_${status}: ${res.statusText}${snippet}` };
  }
  let xml: string;
  try {
    xml = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status, error: `network: 读响应体失败（${msg}）` };
  }
  try {
    const feed = parseFeed(xml);
    if (feed === null) {
      return { ok: false, status, error: 'bad_xml: 根元素不是 rss / feed / RDF，认不出是订阅源' };
    }
    return { ok: true, status, ...feed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status, error: `bad_xml: 解析失败（${msg}）` };
  }
}

// ── feed 组装 ────────────────────────────────────────────────────────

interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

function parseFeed(xml: string): ParsedFeed | null {
  const root = parseXml(xml);
  if (root === null) return null;
  const rl = root.local;
  if (rl !== 'rss' && rl !== 'feed' && rl !== 'rdf') return null; // rdf = RSS 1.0 的 rdf:RDF（local name 已统一小写）
  const isAtom = rl === 'feed';
  const entries = pickEntries(root, isAtom);
  return { title: feedTitleOf(root), items: dedupByLink(entries.map(itemFrom)) };
}

/** 条目节点：RSS 找 item，Atom 找 entry。残缺源壳与内容不一致时两个都试。 */
function pickEntries(root: XmlNode, isAtom: boolean): XmlNode[] {
  const tag = isAtom ? 'entry' : 'item';
  let nodes = allDesc(root, tag);
  if (nodes.length === 0) nodes = allDesc(root, isAtom ? 'item' : 'entry');
  return nodes;
}

function feedTitleOf(root: XmlNode): string {
  if (root.local === 'feed') {
    const t = child(root, 'title');
    return t === null ? '' : plain(allText(t));
  }
  // RSS 2.0 / RSS 1.0：标题在 channel 里；残缺源退回根下的 title
  const channel = allDesc(root, 'channel')[0];
  const t = child(channel ?? root, 'title');
  return t === null ? '' : plain(allText(t));
}

function itemFrom(n: XmlNode): FeedItem {
  if (n.local === 'entry') {
    return {
      title: textOfChild(n, 'title'),
      link: atomLinkOf(n),
      published: firstText(n, ['published', 'updated', 'date']),
      text: firstText(n, ['content', 'summary', 'encoded']) ?? '',
    };
  }
  return {
    title: textOfChild(n, 'title'),
    link: firstText(n, ['link']) ?? '',
    // pubDate 是 RSS 2.0 正名；有的源用 dc:date
    published: firstText(n, ['pubdate', 'date']),
    // content:encoded（全文）优先于 description（摘要）；encoded 是 content:encoded 的 local name
    text: firstText(n, ['encoded', 'description', 'content']) ?? '',
  };
}

/** Atom：<link rel="alternate"> 优先，其次不带 rel 的，再退回第一个；href 缺失时收文本。 */
function atomLinkOf(n: XmlNode): string {
  const links = n.children.filter((c) => c.local === 'link');
  const pick =
    links.find((l) => l.attrs.get('rel') === 'alternate') ??
    links.find((l) => !l.attrs.has('rel')) ??
    links[0];
  if (pick === undefined) return '';
  const href = pick.attrs.get('href');
  if (href !== undefined && href !== '') return href;
  return plain(allText(pick));
}

/** 去重键 = link；无 link 的条目不参与去重。 */
function dedupByLink(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of items) {
    if (it.link !== '') {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
    }
    out.push(it);
  }
  return out;
}

// ── 文本清洗（两条管线，见文件头说明）───────────────────────────────

/** 标题/链接/日期：剥真实标签 → 解实体 → 折叠空白。解出来的尖括号是字面量，不当标签。 */
function plain(raw: string): string {
  return collapseWhitespace(decodeEntities(stripTags(raw)));
}

/** 正文：解实体 → 剥标签 → 折叠空白。CDATA 包 HTML 与转义 HTML 两种形态都归成纯文本。 */
function asText(raw: string): string {
  return collapseWhitespace(stripTags(decodeEntities(raw)));
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

/** 基本实体词表（amp 走单独的替换轮次）。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * 基本实体：连续转义逐层解，直到稳定（上限 3 层）。
 *
 * 为什么不「只解一层」：type="html" 的内容天然是「XML 转义一层 + HTML 再转义一层」
 * （&amp;amp; 应显示为 &），单层解完会剩 &amp; 字面量 —— 实测 fixture 当场踩中。
 * 代价：刻意写成 &amp;lt; 的字面文本会被多解一层，feed 场景里几乎不存在，认了。
 */
function decodeEntities(s: string): string {
  let cur = s;
  for (let round = 0; round < 3; round++) {
    if (!cur.includes('&')) break;
    const next = decodeOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function decodeOnce(s: string): string {
  let out = s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => fromCodePoint(parseInt(d, 10)));
  // 词表逐个换；&amp; 必须最后（否则 &amp;lt; 会被当 &lt; 再解一层）
  for (const [name, val] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(`&${name};`).join(val);
  }
  return out.split('&amp;').join('&');
}

function fromCodePoint(cp: number): string {
  // 拒绝超界与 UTF-16 代理区（fromCodePoint 对后者直接抛错）
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

// ── 手写 XML 树（local name 匹配；CDATA 按原文；注释/PI/DOCTYPE 跳过）──

interface XmlNode {
  /** 去掉命名空间前缀后的标签名（小写化，容错 <PubDate>）。 */
  local: string;
  /** 属性（local name → 解码后的值）。 */
  attrs: Map<string, string>;
  children: XmlNode[];
  /** 直接文本（原文：实体未解；CDATA 为原文内容）。 */
  raw: string[];
}

function parseXml(src: string): XmlNode | null {
  let root: XmlNode | null = null;
  const stack: XmlNode[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(stack, src.slice(i));
      break;
    }
    if (lt > i) pushText(stack, src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const raw = end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      pushText(stack, raw);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      // <?xml …?> / <!DOCTYPE …>（内部子集含 '>' 的极端写法不追求兼容）
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src.startsWith('</', lt)) {
      // 容错：不校验标签配对，直接弹栈
      stack.pop();
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(src, lt);
    if (gt < 0) break; // 标签没闭合，到此为止
    const inner = src.slice(lt + 1, gt);
    const selfClose = inner.endsWith('/');
    const node = openTag(selfClose ? inner.slice(0, -1) : inner);
    if (node !== null) {
      if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
      else if (root === null) root = node;
      if (!selfClose) stack.push(node);
    }
    i = gt + 1;
  }
  return root;
}

/** 标签体内找 '>'，跳过引号里的（属性值可能含 >）。 */
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function openTag(body: string): XmlNode | null {
  const m = /^[^\s/>]+/.exec(body.trimStart());
  if (m === null) return null;
  const node: XmlNode = {
    local: localName(m[0]!).toLowerCase(),
    attrs: new Map(),
    children: [],
    raw: [],
  };
  const rest = body.slice(m[0].length);
  const attrRe = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(rest)) !== null) {
    const key = localName(am[1]!).toLowerCase();
    if (key === '') continue;
    node.attrs.set(key, decodeEntities(am[2] ?? am[3] ?? am[4] ?? ''));
  }
  return node;
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

function pushText(stack: XmlNode[], s: string): void {
  if (stack.length === 0) return; // 根外的文本直接丢
  stack[stack.length - 1]!.raw.push(s);
}

/** 第一个指定 local name 的直接子元素。 */
function child(n: XmlNode, local: string): XmlNode | null {
  for (const c of n.children) {
    if (c.local === local) return c;
  }
  return null;
}

/** 全树（先根序）里所有指定 local name 的后代元素。 */
function allDesc(n: XmlNode, local: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (x: XmlNode): void => {
    for (const c of x.children) {
      if (c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

/** 自身与全部后代的文本按文档序拼接。 */
function allText(n: XmlNode): string {
  let out = n.raw.join('');
  for (const c of n.children) out += allText(c);
  return out;
}

function textOfChild(n: XmlNode, local: string): string {
  const c = child(n, local);
  return c === null ? '' : plain(allText(c));
}

/** 依次试 locals，第一个清洗后非空的直接子元素文本。 */
function firstText(n: XmlNode, locals: readonly string[]): string | null {
  for (const l of locals) {
    const c = child(n, l);
    if (c === null) continue;
    const t = asText(allText(c));
    if (t !== '') return t;
  }
  return null;
}