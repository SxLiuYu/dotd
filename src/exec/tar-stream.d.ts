/**
 * src/exec/tar-stream.d.ts —— tar-stream 的最小类型声明（同 dockerode.d.ts 的动机）。
 *
 * tar-stream 2.2.0 是 dockerode 的传递依赖：node_modules 里有、自带类型没有、
 * package.json 不列（CONVENTIONS.md：不新增 npm 依赖）。本文件只声明 fleet.ts
 * §3.2 内存构建上下文用到的 pack() 形状；运行行为由部署环境 dockerd 实测。
 */

declare module 'tar-stream' {
  import type { Readable } from 'node:stream';

  interface PackEntry {
    name: string;
    size?: number;
    mode?: number;
    type?: 'file' | 'directory' | 'symlink' | 'link';
  }

  interface PackStream extends Readable {
    /** buffer 版式（fleet.ts 用的形态）：header.size 必填或由 Buffer 长度决定。 */
    entry(headers: PackEntry, content: Buffer, callback?: (err?: Error | null) => void): void;
    entry(headers: PackEntry, callback?: (err?: Error | null) => void): void;
    /** tar-stream 2.x 结束流：写完尾部填充块；调用后流自行 end。 */
    finalize(): void;
  }

  export function pack(): PackStream;
  const mod: { pack: typeof pack };
  export default mod;
}
