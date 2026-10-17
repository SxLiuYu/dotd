// tools/win-tcp-relay.mjs —— Windows→WSL NAT 中继（免管理员的 portproxy 替代）
// 用途：hy3 代理只绑 127.0.0.1:3065；WSL2 NAT 侧够不着 Windows 回环。
// 本脚本在 0.0.0.0:13065 收 TCP，转发到 127.0.0.1:3065。
// 用法：node tools/win-tcp-relay.mjs [listenPort] [targetPort]
// dotd models.yml 的 base_url 指向 <Windows 侧 IP>:13065/v1 即可，具体 IP
// 由你的网络决定（WSL 网关常见 172.x.0.1）——本脚本绑 0.0.0.0，任何本机
// IP:13065 都进，所以不用改脚本适配 IP 变化。
import { createServer, connect } from 'node:net';

const LISTEN_PORT = Number(process.argv[2] ?? 13065);
const TARGET = { host: '127.0.0.1', port: Number(process.argv[3] ?? 3065) };

const srv = createServer((upstream) => {
  const target = connect({ host: TARGET.host, port: TARGET.port }, () => {
    upstream.pipe(target);
    target.pipe(upstream);
  });
  const die = () => { upstream.destroy(); target.destroy(); };
  upstream.on('error', die);
  target.on('error', die);
  upstream.on('close', () => target.destroy());
  target.on('close', () => upstream.destroy());
});

srv.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`relay :${LISTEN_PORT} -> ${TARGET.host}:${TARGET.port}`);
});
srv.on('error', (e) => {
  console.error('relay listen failed:', e.message);
  process.exit(1);
});
