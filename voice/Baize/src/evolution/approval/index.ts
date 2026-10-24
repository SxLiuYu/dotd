/**
 * 审批模块 - 自进化审批流程
 */
import { EvolutionRequest, EvolutionPermission } from '../../types';
import { getDatabase } from '../../memory/database';
import { getLogger } from '../../observability/logger';
import { v4 as uuidv4 } from 'uuid';

const logger = getLogger('evolution:approval');

/**
 * 审批状态
 */
export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

/**
 * 审批请求
 */
export interface ApprovalRequest {
  id: string;
  evolutionRequestId: string;
  targetPath: string;
  description: string;
  status: ApprovalStatus;
  createdAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedReason?: string;
}

/**
 * 审批管理器
 */
export class ApprovalManager {
  private db = getDatabase();
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private approvalTimeout: number = 3600000; // 1小时

  /**
   * 创建审批请求
   */
  createRequest(evolutionRequest: EvolutionRequest): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: uuidv4(),
      evolutionRequestId: evolutionRequest.id,
      targetPath: evolutionRequest.targetPath,
      description: evolutionRequest.description,
      status: ApprovalStatus.PENDING,
      createdAt: new Date(),
    };

    this.pendingApprovals.set(approval.id, approval);
    
    logger.info(`创建审批请求: ${approval.id}`, {
      targetPath: evolutionRequest.targetPath,
    });

    return approval;
  }

  /**
   * 批准请求
   */
  approve(approvalId: string, approvedBy: string = 'user'): boolean {
    const approval = this.pendingApprovals.get(approvalId);
    
    if (!approval) {
      logger.warn(`审批请求不存在: ${approvalId}`);
      return false;
    }

    if (approval.status !== ApprovalStatus.PENDING) {
      logger.warn(`审批请求已处理: ${approvalId}`);
      return false;
    }

    approval.status = ApprovalStatus.APPROVED;
    approval.approvedBy = approvedBy;
    approval.approvedAt = new Date();

    this.recordApproval(approval);
    this.pendingApprovals.delete(approvalId);
    
    logger.info(`审批通过: ${approvalId}`, { approvedBy });
    return true;
  }

  /**
   * 拒绝请求
   */
  reject(approvalId: string, reason: string): boolean {
    const approval = this.pendingApprovals.get(approvalId);
    
    if (!approval) {
      logger.warn(`审批请求不存在: ${approvalId}`);
      return false;
    }

    if (approval.status !== ApprovalStatus.PENDING) {
      logger.warn(`审批请求已处理: ${approvalId}`);
      return false;
    }

    approval.status = ApprovalStatus.REJECTED;
    approval.rejectedReason = reason;

    this.recordApproval(approval);
    this.pendingApprovals.delete(approvalId);
    
    logger.info(`审批拒绝: ${approvalId}`, { reason });
    return true;
  }

  /**
   * 获取待审批请求
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * 获取审批请求
   */
  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  /**
   * 检查过期
   */
  checkExpired(): void {
    const now = Date.now();
    
    for (const [id, approval] of this.pendingApprovals) {
      if (now - approval.createdAt.getTime() > this.approvalTimeout) {
        approval.status = ApprovalStatus.EXPIRED;
        this.recordApproval(approval);
        this.pendingApprovals.delete(id);
        logger.warn(`审批请求过期: ${id}`);
      }
    }
  }

  /**
   * 记录审批历史
   */
  private recordApproval(approval: ApprovalRequest): void {
    this.db.run(
      `INSERT INTO evolution_history (timestamp, request_id, type, target, description, result)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        approval.evolutionRequestId,
        'approval',
        approval.targetPath,
        approval.description,
        approval.status,
      ]
    );
  }

  /**
   * 格式化审批消息
   */
  formatApprovalMessage(approval: ApprovalRequest): string {
    const lines = [
      '📋 进化审批请求',
      '',
      `目标: ${approval.targetPath}`,
      `描述: ${approval.description}`,
      `时间: ${approval.createdAt.toLocaleString()}`,
      '',
      '请选择操作:',
      '  1. 批准',
      '  2. 拒绝',
    ];

    return lines.join('\n');
  }
}

// 全局实例
let approvalManager: ApprovalManager | null = null;

export function getApprovalManager(): ApprovalManager {
  if (!approvalManager) {
    approvalManager = new ApprovalManager();
  }
  return approvalManager;
}
