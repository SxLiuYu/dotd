/**
 * tests/voice-container-image.test.ts —— 镜像是不是"能听能说"，而不是只会回 /health。
 *
 * 背景（2026-10-25 实测，`docker run --rm --entrypoint python charlie-dotd:latest`）：
 *
 *     edge_tts NO   sherpa_onnx NO   lark_oapi NO
 *     opuslib  NO   av          NO   soundfile NO
 *
 * 也就是说镜像能起、`/health` 全绿、控制台能开，但**说不出话也听不见**：
 *   - 没 edge_tts → TTS_PRIORITY 里的 edge 直接不可用，链路上剩下的四个都要 key/本地服务；
 *   - 没 sherpa_onnx（+ 237MB 模型）→ ASR 整条链返回空字符串；
 *   - 没 opuslib/av → ESP32 的 opus 帧解不开、音频转换走不了；
 *   - 没 lark_oapi → 飞书长连接模块 import 就失败。
 *
 * 之前这些依赖只写在 `voice/requirements-real-audio.txt`（"真音频验收"用），Dockerfile
 * 只装 `requirements-core.txt`，两边从没对齐过。这条门禁用纯文本断言守住三件事：
 *
 *   1. requirements-container.txt 声明了每个运行时必装的包；
 *   2. Dockerfile 真的 COPY + pip install 了那份文件，并装了系统库 libopus；
 *   3. entrypoint 会在后台把 SenseVoice 模型下到数据卷（否则装了 sherpa 也听不见）。
 *
 * 不做真构建：CI 里没有 docker 也不该花 4 分钟。构建验收走手工/发布前流程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

/** 每个包为什么必须在镜像里 —— 失败信息直接说清后果。 */
const REQUIRED = [
  ['edge-tts', 'TTS 默认链路的唯一免费兜底（TTS_PRIORITY 第一位）'],
  ['sherpa-onnx', '本地 ASR（SenseVoice）的推理引擎'],
  ['opuslib', 'ESP32 设备的 opus 编解码'],
  ['av', 'PyAV：音频容器/重采样'],
  ['soundfile', 'WAV 读写（TTS 落盘、ASR 输入）'],
  ['lark-oapi', '飞书长连接 SDK'],
] as const;

test('镜像依赖清单声明了所有运行时音频/ASR 包', () => {
  // container 清单用 `-r requirements-voice.txt` 继承上一层，所以要把整条链
  // 摊开看，而不是只 grep 一个文件。
  const chain = resolveRequirements('voice/requirements-container.txt');
  for (const [pkg, why] of REQUIRED) {
    const re = new RegExp(`^\\s*${pkg.replace(/[-]/g, '[-_]')}\\s*[>=<~!]`, 'im');
    assert.match(chain, re, `requirements-container.txt 及其 -r 链缺 ${pkg}：${why}`);
  }
});

/** 把 `-r xxx.txt` 递归展开成一份合并文本（requirements 的相对路径按文件所在目录解析）。 */
function resolveRequirements(rel: string, seen = new Set<string>()): string {
  assert.ok(!seen.has(rel), `requirements 循环引用：${rel}`);
  seen.add(rel);
  const dir = dirname(rel);
  let text = read(rel);
  for (const m of text.matchAll(/^\s*-r\s+(\S+)\s*$/gm)) {
    text += '\n' + resolveRequirements(join(dir, m[1] ?? ''), seen);
  }
  return text;
}

test('容器清单继承 voice 层，不重复也不漏', () => {
  const manifest = read('voice/requirements-container.txt');
  assert.match(
    manifest,
    /^\s*-r\s+requirements-voice\.txt\s*$/m,
    'container 清单应 -r 引 voice 层（拿到 edge-tts / lark-oapi），不要各写一份',
  );
  // 同目录解析：Dockerfile 必须把三份一起 COPY 到 /tmp，否则 -r 相对路径断。
  const dockerfile = read('docker/Dockerfile.voice');
  for (const f of ['requirements-integration.txt', 'requirements-voice.txt', 'requirements-container.txt']) {
    assert.ok(
      dockerfile.includes(f),
      `Dockerfile 没 COPY ${f}；-r 的相对路径会在 /tmp 里解析失败`,
    );
  }
});

test('Dockerfile 真的装了容器清单和 libopus', () => {
  const dockerfile = read('docker/Dockerfile.voice');
  assert.match(
    dockerfile,
    /pip install[^\n]*-r\s+\/tmp\/requirements-container\.txt/,
    'Dockerfile 必须 pip install requirements-container.txt（只装 core 会得到又聋又哑的镜像）',
  );
  // apt 那段是 `\` 续行的，单行正则匹配不到，先把续行接起来。
  const joined = dockerfile.replace(/\\\n\s*/g, ' ');
  assert.match(
    joined,
    /apt-get install[^&]*libopus0/,
    '缺 libopus0：opuslib 装得上但运行时 dlopen 失败',
  );
});

test('entrypoint 会把 SenseVoice 模型下到数据卷', () => {
  const entry = read('docker/entrypoint.sh');
  assert.match(entry, /voice\/models\/sense-voice/, '模型应落在数据卷（重建容器不重下）');
  // 必须走多源下载器，不能用上游 download-models.py：它只有 GitHub release 一个
  // 源，2026-10-25 国内实测 20s 超时 0 字节 —— 等于"自动下载"永远失败。
  assert.match(
    entry,
    /voice\.integration\.asr_model/,
    'entrypoint 应调用 voice/integration/asr_model（多源 + 原子落盘）',
  );
  // 注释里会提到"为什么不用上游脚本"，所以只在**去掉注释行**之后检查调用。
  const code = entry
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.doesNotMatch(code, /scripts\/download-models\.py/, '上游脚本只有 GitHub 一个源，国内必失败');
  assert.match(
    entry,
    /DOTD_DOWNLOAD_ASR_MODEL/,
    '需要开关：离线环境/自备模型时能关掉下载',
  );
  // 必须后台跑：237MB 会超过 healthcheck 的 start_period，前台跑会让容器一直不 healthy。
  const block = entry.slice(entry.indexOf('SenseVoice'));
  assert.match(block, /\)\s*&/, '下载必须放后台（阻塞会拖过 healthcheck 的 start_period）');
});

test('多源下载器存在且 GitHub 挂了会换镜像', () => {
  const src = read('voice/integration/asr_model.py');
  assert.match(src, /github\.com\/k2-fsa/, '保留上游原地址（海外机器最快）');
  assert.match(src, /hf-mirror\.com/, '国内可达的镜像必须在内置来源里');
  assert.match(src, /SENSE_VOICE_MIRROR/, '自建/内网镜像要能通过环境变量注入');
  assert.match(src, /os\.replace/, '落盘必须原子：半截 model.int8.onnx 比没有更糟');
  assert.match(src, /MIN_MODEL_BYTES/, '就绪判定要看大小，0 字节文件不算模型');
});

test('模型后到也能听（不用重启）', () => {
  const watch = read('voice/integration/asr_watch.py');
  // 上游 _load_sense_voice 只读一次路径；启动时模型还没下完的话永远聋。
  assert.match(watch, /SENSE_VOICE_MODEL/, '发现模型后要设置环境变量');
  assert.match(watch, /_sense_voice_recognizer\s*=\s*None/, '必须清上游单例，否则还用旧路径');
  const one = read('voice/integration/one_system.py');
  assert.match(one, /asr_watch\.watch_async/, 'one_system 启动时要挂上监视');
});

test('one_system 只在模型真的存在时覆盖 SENSE_VOICE_MODEL', () => {
  const src = read('voice/integration/one_system.py');
  const i = src.indexOf('SENSE_VOICE_MODEL');
  assert.ok(i > 0, 'apply_env 应把数据卷里的模型路径告诉 Charlie');
  const snippet = src.slice(i - 400, i + 500);
  assert.match(
    snippet,
    /is_file\(\)/,
    '必须先判断文件存在再覆盖：写一个不存在的路径会让 ASR 报"模型不存在"',
  );
  assert.match(snippet, /setdefault|strip\(\)/, '显式配置优先，不能硬覆盖主人自己的值');
});
