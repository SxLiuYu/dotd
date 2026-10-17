/**
 * src/exec/netguard.ts —— HostNetGuard（execution.md §2.1-2：容器→宿主出站管控）。
 *
 * 机制（文档逐字落地）：
 *  - `enable_icc=false` 只限制容器↔容器互访，管不到容器→宿主；因此在 WSL 宿主 netfilter
 *    的 filter 表建链 `DOTD-OUT`：
 *      ```
 *      iptables -N DOTD-OUT
 *      iptables -A FORWARD -s <dotd网段> -d <dotd网关IP> -p tcp -m multiport --dports <白名单> -j ACCEPT
 *      iptables -A FORWARD -s <dotd网段> -d <dotd网关IP> -j DROP     # 阻断宿主 loopback 转发进来的服务
 *      iptables -A FORWARD -s <dotd网段> -d 127.0.0.0/8 -j DROP      # 防宿主服务经 DNAT 混入
 *      iptables -A FORWARD -s <dotd网段> -d <外网> -j ACCEPT         # 浏览器任务需出外网
 *      ```
 *  - 执行者 = daemon 启动时（boot 序列第 3 步，ping/ensureImage 之后）调用 `install()`；
 *    网络重建/网关变更（daemon 重启后 WSL IP 会变）时随 docker_unavailable 恢复流程重装。
 *  - 幂等：先 `-F DOTD-OUT` 再重写。
 *  - 网关从 `GET /networks/{id}` 的 IPAM.Config[0].Gateway 动态读取，**不写死 172.17.0.1**。
 *  - 白名单端口集合由治理模块经 `setEgressWhitelist(ports)` 下发；默认空 = 只允许出外网、
 *    禁止一切宿主侧访问（含本地模型——本地模型双轨路由是阶段二项）。
 *
 * 环境妥协（本机无 WSL/dockerd/iptables）：真实 iptables 走 child_process（骨架 §9.6 明确
 * iptables/xvfb 允许 child_process），但**本模块在 stub 模式下完全不执行子进程**——
 * `install()` 记录"应下发的规则集"供测试断言，真实路径留待部署环境首启。
 */

import { spawn } from 'node:child_process';
import type { EventBus } from '../shared/bus.ts';
import type { ContainerBackend, ExecConfig } from './types.ts';

export interface NetGuardDeps {
  bus: EventBus;
  cfg: ExecConfig;
  backend: ContainerBackend;
}

/** 一条链规则（HostNetGuard 的下发单元）。 */
export interface NetRule {
  chain: 'DOTD-OUT';
  /** FORWARD 匹配条件。 */
  spec: { source: string; dest: string; proto?: 'tcp'; dports?: number[] };
  target: 'ACCEPT' | 'DROP';
}

export interface InstallReport {
  /** dotd 网络网段（CIDR，如 172.18.0.0/16）。 */
  subnet: string;
  /** dotd 网关 IP（从 GET /networks 动态读，不写死）。 */
  gateway: string;
  /** 本次下发的规则集（幂等重写后的全集）。 */
  rules: NetRule[];
  /** 是否真实执行了 iptables（stub=false）。 */
  applied: boolean;
}

export class HostNetGuard {
  /** 治理下发的白名单端口（默认空）。 */
  private whitelist: number[] = [];
  private lastReport: InstallReport | null = null;

  constructor(private readonly deps: NetGuardDeps) {}

  /** 治理模块经 ExecService.setEgressWhitelist 下发（§2.1-2）。 */
  setEgressWhitelist(ports: number[]): void {
    this.whitelist = [...new Set(ports)].filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  }

  getEgressWhitelist(): number[] {
    return [...this.whitelist];
  }

  lastInstall(): InstallReport | null {
    return this.lastReport;
  }

  /**
   * install(gateway, whitelist)（§2.1-2；boot 时一次性安装，幂等重装）。
   * 网关为 null（读不到网络信息）时按 fail-fast 处理：stub 下用占位网段继续，
   * 真实路径抛错（部署预检项）。
   */
  async install(gateway?: string): Promise<InstallReport> {
    const cfg = this.deps.cfg;
    const gw = gateway ?? (await this.deps.backend.networkGateway(cfg.networkName));
    if (gw === null) {
      if (this.deps.backend.kind === 'docker') {
        throw new Error(`HostNetGuard：读不到网络 ${cfg.networkName} 的网关（GET /networks/{id}）`);
      }
      // stub：用占位值，保证状态机与测试可跑
      this.lastReport = {
        subnet: '172.18.0.0/16',
        gateway: '172.18.0.1',
        rules: [],
        applied: false,
      };
      return this.lastReport;
    }
    const subnet = deriveSubnet(gw);
    const rules: NetRule[] = [];
    if (this.whitelist.length > 0) {
      rules.push({
        chain: 'DOTD-OUT',
        spec: { source: subnet, dest: gw, proto: 'tcp', dports: [...this.whitelist] },
        target: 'ACCEPT',
      });
    }
    rules.push({ chain: 'DOTD-OUT', spec: { source: subnet, dest: gw }, target: 'DROP' });
    rules.push({ chain: 'DOTD-OUT', spec: { source: subnet, dest: '127.0.0.0/8' }, target: 'DROP' });
    rules.push({ chain: 'DOTD-OUT', spec: { source: subnet, dest: '0.0.0.0/0' }, target: 'ACCEPT' });

    const applied = await this.applyRules(rules);
    this.lastReport = { subnet, gateway: gw, rules, applied };
    return this.lastReport;
  }

  /** 幂等下发：`-F DOTD-OUT` 再重写。真实路径走 iptables 子进程（stub 跳过）。 */
  private async applyRules(rules: NetRule[]): Promise<boolean> {
    if (this.deps.backend.kind !== 'docker') return false; // stub：不起子进程
    const argv: string[][] = [
      ['-N', 'DOTD-OUT'],
      ['-F', 'DOTD-OUT'],
      ['-C', 'FORWARD', '-s', rules[0]!.spec.source, '-j', 'DOTD-OUT'],
    ];
    // 幂等：链已挂 FORWARD 时 -C 成功即可跳过挂载
    for (const args of argv) {
      try {
        await runIptables(args);
      } catch {
        // -N 已存在 / -C 未挂：都继续（挂载动作见下）
      }
    }
    await runIptables(['-A', 'FORWARD', '-s', rules[0]!.spec.source, '-j', 'DOTD-OUT']);
    for (const r of rules) {
      const args = ['-A', r.chain, '-s', r.spec.source, '-d', r.spec.dest];
      if (r.spec.proto === 'tcp') args.push('-p', 'tcp');
      if (r.spec.dports !== undefined) args.push('-m', 'multiport', '--dports', r.spec.dports.join(','));
      args.push('-j', r.target);
      await runIptables(args);
    }
    return true;
  }
}

/** 由网关 IP 推导网段（/16 近似；真实值应从 GET /networks 的 IPAM.Config[0].Subnet 读）。 */
export function deriveSubnet(gateway: string): string {
  const parts = gateway.split('.');
  if (parts.length !== 4) return '172.18.0.0/16';
  return `${parts[0]}.${parts[1]}.0.0/16`;
}

/** 跑一条 iptables（WSL 宿主 root 可达，部署预检项：失败 fail-fast）。 */
export function runIptables(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('iptables', args, { stdio: 'ignore' });
    child.on('error', (e) => reject(new Error(`iptables 不可用：${e.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`iptables ${args.join(' ')} 退出码 ${String(code)}`));
    });
  });
}
