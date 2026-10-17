/**
 * web-ui/src/vite-env.d.ts —— 环境类型补齐（骨架自备，不依赖 vite 包的 types 入口）。
 *
 * 装了 vite 之后 `types: ["vite/client"]` 或 `/// <reference types="vite/client" />`
 * 都能提供这些声明；骨架期不装包，所以自备一份等价的，让 `tsc --noEmit` 在缺包时
 * 只剩 react 相关报错（npm install 后全绿）。
 */

declare module '*.css';

/** vite.config.ts 的 import.meta.env（占位期未用到，先补形状）。 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  /**
   * daemon 基址（web-ui/src/api.ts 消费）。缺省 = 当前页面 origin（UI 与 daemon
   * 同源部署）；开发期 UI 跑在 vite dev server 而 daemon 另起时，用它指向
   * 如 http://127.0.0.1:7788。定义在 web-ui/.env.local 或 vite --mode 注入。
   */
  readonly VITE_DOTD_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
