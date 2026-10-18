/**
 * src/surfaces/feishu-media.ts —— 飞书媒体消息（图片/文件）下载（2026-10-18）。
 *
 * 背景（对标 OpenAI bot 的多模态输入）：
 * 飞书图片消息的 content 只有 `{"image_key":"img_xxx"}`，**没有图片本体**。
 * 要拿到图片必须再调一次 `GET /open-apis/im/v1/images/{image_key}`。
 * 原来 inbound 把非文本消息一律 `ignore: non_text`，主人发张截图问"这是什么"，
 * bot 只会当没看见。
 *
 * 本模块只做一件事：**把 image_key 换成落在家目录里的文件**，并返回相对路径。
 * 之后模型用 `fs.read`/`fs.stat` 就能拿到（视觉识别走后续的模型能力）。
 *
 * 纪律：
 *   - 下载失败**不阻塞**文本部分：失败就当没有附件，并如实告知主人；
 *   - 文件名用 image_key 派生（同一张图重复发不会堆积）；
 *   - 只认图片；其它类型（文件/音频/视频）暂时只回报"暂不支持"，不硬塞。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 飞书开放平台基址（与 inbound 的 token 校验同一个域）。 */
const FEISHU_API = 'https://open.feishu.cn/open-apis';

/** 存图片的子目录（在 home 内，模型可直接 fs.read）。 */
export const MEDIA_DIR = 'media';
/** 单张图片上限：飞书图片最大 10MB，这里给 12MB 余量，超了不下载。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface DownloadedMedia {
  /** home 内相对路径，如 media/img_abc.png。 */
  path: string;
  /** 字节数。 */
  sizeBytes: number;
  /** 探测到的 MIME（image/png 等）。 */
  contentType: string;
}

export interface MediaDownloadDeps {
  /** 取 tenant_access_token（复用 inbound 已有的校验逻辑）。 */
  tenantToken: () => Promise<string | null>;
  /** home 卷根目录（容器内为 /dot/home，宿主装配时传实际路径）。 */
  homeRoot: string;
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** 从飞书消息 content 里取出 image_key（非图片返回 null）。 */
export function imageKeyOf(msgType: string, contentJson: string): string | null {
  if (msgType !== 'image') return null;
  try {
    const obj = JSON.parse(contentJson) as { image_key?: unknown };
    return typeof obj.image_key === 'string' && obj.image_key.length > 0 ? obj.image_key : null;
  } catch {
    return null;
  }
}

/** 按魔数猜扩展名（飞书返回的 content-type 不一定可靠）。 */
function extOf(buf: Buffer, contentType: string): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('webp')) return 'webp';
  return 'bin';
}

/**
 * 下载一张飞书图片到 home 卷。
 *
 * 失败返回 `{ ok: false, error }`——**调用方应当把 error 如实转告主人**，
 * 而不是静默当没有附件（那会让主人以为 bot 眼瞎）。
 */
export async function downloadFeishuImage(
  imageKey: string,
  deps: MediaDownloadDeps,
): Promise<{ ok: true; media: DownloadedMedia } | { ok: false; error: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  let token: string | null;
  try {
    token = await deps.tenantToken();
  } catch (cause) {
    return { ok: false, error: `取飞书 token 失败：${String(cause)}` };
  }
  if (token === null) return { ok: false, error: '取不到飞书 tenant token（凭证可能失效）' };

  let res: Response;
  try {
    res = await doFetch(`${FEISHU_API}/im/v1/images/${encodeURIComponent(imageKey)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, error: `下载图片请求失败：${String(cause)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `下载图片失败：HTTP ${res.status}` };
  }

  const contentType = res.headers.get('content-type') ?? '';
  // 飞书成功时直接返回二进制；失败时返回 JSON（带 code/message）——先按长度挡一道。
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.byteLength === 0) return { ok: false, error: '下载到的图片为空' };
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: `图片太大（${buf.byteLength} 字节 > 12MB 上限）` };
  }
  // 若是 JSON 错误体，说明没拿到图
  if (contentType.includes('application/json')) {
    const msg = buf.toString('utf8').slice(0, 200);
    return { ok: false, error: `飞书返回错误：${msg}` };
  }

  const ext = extOf(buf, contentType);
  if (ext === 'bin') {
    return { ok: false, error: `不认识的图片格式（content-type=${contentType || '空'}）` };
  }

  const rel = `${MEDIA_DIR}/${imageKey.replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`;
  try {
    mkdirSync(join(deps.homeRoot, MEDIA_DIR), { recursive: true });
    writeFileSync(join(deps.homeRoot, rel), buf);
  } catch (cause) {
    return { ok: false, error: `保存图片失败：${String(cause)}` };
  }
  return { ok: true, media: { path: rel, sizeBytes: buf.byteLength, contentType } };
}
