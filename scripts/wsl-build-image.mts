// 真实构建一次 dotd/exec 镜像：走 daemon 生产代码路径（buildContextTar + dockerode）。
// 用法（WSL 内）：cd ~/dotd && node --import tsx scripts/wsl-build-image.mts
import { execConfigFromEnv } from '../src/exec/types.ts';
import { createDockerBackend } from '../src/exec/fleet.ts';

const cfg = execConfigFromEnv();
const backend = createDockerBackend(cfg);
const tag = `dotd/exec:${cfg.pwVersion}-${cfg.runtimeVer}`;

console.log('ping:', await backend.ping());
if (await backend.hasImage(tag)) {
  console.log('IMAGE_ALREADY_PRESENT', tag);
  process.exit(0);
}
console.log('building', tag, '...');
const t0 = Date.now();
const r = await backend.buildImage(tag, cfg.pwVersion, (line) => {
  if (line.length < 200) console.log(line);
});
console.log('BUILT', JSON.stringify(r), `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('hasImage:', await backend.hasImage(tag));
