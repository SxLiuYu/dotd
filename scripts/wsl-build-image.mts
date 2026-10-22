// 真实构建一次 dotd/exec 镜像：走 daemon 生产代码路径（buildContextTar + dockerode）。
// 用法（WSL 内）：cd ~/dotd && node --import tsx scripts/wsl-build-image.mts
import { execConfigFromEnv } from '../src/exec/types.ts';
import { createDockerBackend } from '../src/exec/fleet.ts';

const cfg = execConfigFromEnv();
const backend = createDockerBackend(cfg);
const tag = `dotd/exec:${cfg.baseImageTag}-${cfg.runtimeVer}`;

// --force：tag 已存在也要重建（scripts/rebuild-image.sh 用）。
// 没有这个开关时，本脚本遇到已存在的 tag 直接 exit 0 打印 IMAGE_ALREADY_PRESENT，
// 于是"重建镜像"的调用方会拿到**退出码 0 而什么都没重建** —— 换基座这种改动
// 恰恰是"tag 已存在但内容不对"的场景，静默跳过是最坏的行为。
const force = process.argv.includes('--force');

console.log('ping:', await backend.ping());
if (!force && (await backend.hasImage(tag))) {
  console.log('IMAGE_ALREADY_PRESENT', tag, '（要重建加 --force）');
  process.exit(0);
}
console.log('building', tag, '...');
const t0 = Date.now();
const r = await backend.buildImage(tag, cfg.baseImageTag, (line) => {
  if (line.length < 200) console.log(line);
});
console.log('BUILT', JSON.stringify(r), `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('hasImage:', await backend.hasImage(tag));
