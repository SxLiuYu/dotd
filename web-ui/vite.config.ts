import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * web-ui/vite.config.ts —— 占位骨架。
 *
 * 真内容由 surfaces 模块填充（surfaces.md §7：聊天流 / Queue / Breaker / Approvals /
 * Events / Models / Logs / Settings）。这里只保证 `npm --prefix web-ui run build` 能过。
 *
 * 关键约定（surfaces.md §5.2 / §4.5）：
 * - 后端唯一监听 127.0.0.1:7788（契约 H2：CP 的 8642 作废）；
 * - dev server 的 /api 代理到该端口，避免 CORS 与 token 跨域；
 * - 生产构建产物由 surfaces 的 web.ts 静态托管（SF §5.2 路径表）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7788', changeOrigin: true },
      '/hooks': { target: 'http://127.0.0.1:7788', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
