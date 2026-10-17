// scripts/win-relay.mts —— Windows 侧 TCP 转发器（绑 0.0.0.0 高位端口，无需管理员）
// 让 WSL 里的 dotd daemon 经默认网关够着 Windows 上只绑 127.0.0.1 的两个模型服务。
//   :13065 → 127.0.0.1:3065 (hy3 / Agent2API workbuddy 代理，不校验 Host)
//   :18001 → 127.0.0.1:8001 (Colibrì OLMoE，校验 Host=127.0.0.1，故**每条请求**都重写)
// 背景：WSL2 NAT 下，WSL 的 127.0.0.1 是独立命名空间，够不着 Windows 的 loopback；
// 而 daemon 又必须在 WSL 里才够得着 /var/run/docker.sock 与容器 IP:9223。
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

function pipePlain(sock: Socket, targetPort: number): void {
  const up = createConnection({ host: '127.0.0.1', port: targetPort }, () => {
    sock.pipe(up);
    up.pipe(sock);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
}

// 目标校验 Host 头：把每条请求的 Host 改回它期望的值再直传。
//
// 为什么必须逐条改：连接是 keep-alive，node 的全局 agent 会复用同一条 TCP 连接发
// 后续请求。旧实现只改第一条请求的头（headDone 一锤定音），于是健康探测过了、
// 同一连接上的 /profile、/v1/models 全 403——Colibrì 报
// 「Host header '172.17.48.1' not allowed」，warm 闸永远判不热（2026-10-17
// 全方位测试"tier2 双断点"的第二断点，实测复现）。
// 分帧按 Content-Length 切（GET 无体）；chunked 与异常大头放弃改写整段直传。
function pipeRewriteHost(sock: Socket, targetPort: number, hostValue: string): void {
  let up: Socket | null = null;
  let buf = Buffer.alloc(0);
  let connected = false;

  const writeUp = (b: Buffer): void => {
    if (connected && up !== null) up.write(b);
  };

  /** 消费 buf 里能成帧的部分；半条请求留在 buf 里等下一个 chunk。 */
  const drain = (): void => {
    // 上游还没连上就一个字都不能消费：旧实现在这里把 buf 切掉却不写（writeUp 静默
    // 丢弃），客户端"连上即发文"时首条请求会整段消失——表现为探测无响应、时好时坏。
    if (!connected) return;
    while (buf.length > 0) {
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 65536) {
          writeUp(buf); // 异常大请求头，放弃改写直传
          buf = Buffer.alloc(0);
        }
        return;
      }
      const headText = buf.subarray(0, end).toString('latin1');
      // 重写（或补上）Host 行
      let head = headText;
      if (/^Host:/im.test(head)) head = head.replace(/^Host:.*$/im, `Host: ${hostValue}`);
      else {
        head = head.replace(
          /^(GET|POST|PUT|DELETE|HEAD|OPTIONS)( [^\r\n]*)/i,
          (_m, v, rest) => `${v}${rest}\r\nHost: ${hostValue}`,
        );
      }
      const headBuf = Buffer.from(`${head}\r\n\r\n`, 'latin1');
      const rest = buf.subarray(end + 4);
      const chunked = /transfer-encoding:\s*chunked/i.test(headText);
      const clen = /content-length:\s*(\d+)/i.exec(headText);
      const bodyLen = chunked || clen === null ? 0 : Number(clen[1]);
      if (chunked || rest.length < bodyLen) {
        // 体不完整（或 chunked 不切）：把头改好，剩余原样带上，等后续 chunk
        writeUp(Buffer.concat([headBuf, rest]));
        buf = Buffer.alloc(0);
        return;
      }
      writeUp(Buffer.concat([headBuf, rest.subarray(0, bodyLen)]));
      buf = rest.subarray(bodyLen);
    }
  };

  const connect = (): void => {
    up = createConnection({ host: '127.0.0.1', port: targetPort }, () => {
      connected = true;
      drain(); // 连接前到达的数据此刻才成帧
    });
    up.on('error', () => sock.destroy());
    up.pipe(sock);
  };
  connect();
  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    drain();
  });
  sock.on('error', () => up?.destroy());
}

/**
 * 造一个中继服务端（导出给测试用：指定随机端口 + 假上游即可验 Host 重写语义）。
 * 常跑入口见文件末尾的 `invokedDirectly` 分支。
 */
export function makeRelayServer(targetPort: number, hostRewrite?: string): Server {
  return createServer((sock) => {
    if (hostRewrite !== undefined) pipeRewriteHost(sock, targetPort, hostRewrite);
    else pipePlain(sock, targetPort);
  });
}

// ── 常跑入口（被 import 时不启动，测试才能安全加载本模块）────────────────
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const TTL_MS = Number(process.env.RELAY_TTL_MS ?? 3_600_000);
  const rules: Array<{ listenPort: number; targetPort: number; hostRewrite?: string }> = [
    { listenPort: 13065, targetPort: 3065 }, // hy3（不校验 Host）
    { listenPort: 18001, targetPort: 8001, hostRewrite: '127.0.0.1:8001' }, // OLMoE（校验 Host）
  ];
  for (const r of rules) {
    const srv = makeRelayServer(r.targetPort, r.hostRewrite);
    srv.on('error', (e) => console.log(`relay ${r.listenPort} 启动失败: ${(e as Error).message}`));
    srv.listen(r.listenPort, '0.0.0.0', () =>
      console.log(
        `relay 0.0.0.0:${r.listenPort} -> 127.0.0.1:${r.targetPort}${r.hostRewrite ? ` (Host→${r.hostRewrite})` : ''}`,
      ),
    );
  }
  console.log(`win-relay 就绪，${TTL_MS / 1000}s 后自退（设 RELAY_TTL_MS=0 常跑）`);
  if (TTL_MS > 0) setTimeout(() => process.exit(0), TTL_MS);
}
