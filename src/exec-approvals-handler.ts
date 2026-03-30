/**
 * QQ Exec Approvals Handler.
 *
 * Handles the execution approval workflow via Gateway events:
 * 1. Listens for exec.approval.requested events from Gateway
 * 2. Sends approval request to configured approvers via QQ
 * 3. Handles approval responses via QQ messages
 * 4. Forwards approved/denied decisions back to Gateway
 */

import type { OB11Event } from "./types.js";
import { getActiveNativeClient } from "./qq-native.js";
import { getActiveQqClient } from "./adapter.js";
import {
  isQqExecApprovalEnabled,
  isQqExecApprovalApprover,
  resolveQqExecApprovalTarget,
  matchesQqExecApprovalAgentFilter,
  matchesQqExecApprovalSessionFilter,
  getQqExecApprovalApprovers,
} from "./exec-approvals.js";
import type { QQExecApprovalConfig } from "./exec-approvals.js";

// Gateway event types (simplified from plugin-sdk)
interface ExecApprovalRequest {
  id: string;
  agentId?: string;
  sessionKey?: string;
  command: {
    commandText: string;
  };
  expiresAtMs: number;
}

interface ExecApprovalResolved {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
  ts: number;
}

interface PendingApproval {
  request: ExecApprovalRequest;
  approverId?: string;
  sentAt: number;
  messageId?: string;
}

type RuntimeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type QQExecApprovalHandlerOptions = {
  accountId: string;
  cfg: Record<string, unknown>;
  runtime: RuntimeLogger;
  /** Called when an approval request should be sent to approvers */
  sendApprovalMessage: (params: {
    approverIds: string[];
    approvalId: string;
    commandText: string;
    expiresAt: string;
  }) => Promise<void>;
  /** Called when an approval decision should be forwarded to Gateway */
  forwardApprovalDecision: (params: {
    approvalId: string;
    decision: "allow-once" | "allow-always" | "deny";
  }) => Promise<void>;
};

/**
 * QQ Exec Approval Handler.
 *
 * Manages the lifecycle of exec approval requests:
 * - Validates incoming requests against config
 * - Sends approval requests to approvers
 * - Handles approval responses
 * - Forwards decisions to Gateway
 */
export class QQExecApprovalHandler {
  private readonly opts: QQExecApprovalHandlerOptions;
  private pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingTimeoutIds = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: QQExecApprovalHandlerOptions) {
    this.opts = opts;
  }

  /**
   * Check if this handler should process a given request.
   */
  shouldHandle(request: ExecApprovalRequest): boolean {
    const { cfg, accountId } = this.opts;

    // Check if approvals are enabled
    if (!isQqExecApprovalEnabled({ cfg, accountId })) {
      return false;
    }

    // Check agent filter
    if (!matchesQqExecApprovalAgentFilter({ cfg, accountId, agentId: request.agentId })) {
      this.opts.runtime.debug?.(
        `[QQ/exec-approvals] Skipping request ${request.id}: agent filter mismatch`,
      );
      return false;
    }

    // Check session filter
    if (!matchesQqExecApprovalSessionFilter({ cfg, accountId, sessionKey: request.sessionKey })) {
      this.opts.runtime.debug?.(
        `[QQ/exec-approvals] Skipping request ${request.id}: session filter mismatch`,
      );
      return false;
    }

    return true;
  }

  /**
   * Handle an incoming exec approval request.
   */
  async handleRequested(request: ExecApprovalRequest): Promise<void> {
    const { cfg, accountId, runtime } = this.opts;

    // Check if we should handle this request
    if (!this.shouldHandle(request)) {
      return;
    }

    // Get approvers
    const approverIds = getQqExecApprovalApprovers({ cfg, accountId });
    if (approverIds.length === 0) {
      runtime.warn(`[QQ/exec-approvals] No approvers configured for account ${accountId}`);
      return;
    }

    // Build expiration time string
    const expiresAt = new Date(request.expiresAtMs).toISOString();

    // Store pending approval
    this.pendingApprovals.set(request.id, {
      request,
      sentAt: Date.now(),
    });

    // Send approval message to approvers
    try {
      await this.opts.sendApprovalMessage({
        approverIds,
        approvalId: request.id,
        commandText: request.command.commandText,
        expiresAt,
      });
      runtime.info(
        `[QQ/exec-approvals] Sent approval request ${request.id} to approvers: ${approverIds.join(", ")}`,
      );
    } catch (err) {
      runtime.error(`[QQ/exec-approvals] Failed to send approval request: ${String(err)}`);
      this.pendingApprovals.delete(request.id);
      return;
    }

    // Set timeout for auto-denial
    const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
    if (timeoutMs > 0) {
      const timeoutId = setTimeout(() => {
        void this.handleTimeout(request.id);
      }, timeoutMs);
      timeoutId.unref?.();
      this.pendingTimeoutIds.set(request.id, timeoutId);
    }
  }

  /**
   * Handle an approval decision from an approver.
   */
  async handleApprovalDecision(
    approverId: string,
    decision: "allow-once" | "allow-always" | "deny",
    approvalId?: string,
  ): Promise<void> {
    const { cfg, accountId, runtime } = this.opts;

    // If no approvalId provided, try to find the oldest pending request
    let pending = approvalId ? this.pendingApprovals.get(approvalId) : undefined;

    if (!pending && !approvalId) {
      // Find oldest pending approval
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, p] of this.pendingApprovals) {
        if (p.sentAt < oldestTime) {
          oldestTime = p.sentAt;
          oldestId = id;
          pending = p;
        }
      }
      if (oldestId) {
        approvalId = oldestId;
      }
    }

    if (!pending || !approvalId) {
      runtime.warn(`[QQ/exec-approvals] No pending approval found for decision`);
      return;
    }

    // Verify approver
    if (!isQqExecApprovalApprover({ cfg, accountId, senderId: approverId })) {
      runtime.warn(
        `[QQ/exec-approvals] Non-approver ${approverId} sent decision for ${approvalId}`,
      );
      return;
    }

    // Clear timeout
    const timeoutId = this.pendingTimeoutIds.get(approvalId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.pendingTimeoutIds.delete(approvalId);
    }

    // Remove from pending
    this.pendingApprovals.delete(approvalId);

    runtime.info(
      `[QQ/exec-approvals] Approval ${approvalId} decided: ${decision} by ${approverId}`,
    );

    // Forward decision to Gateway
    try {
      await this.opts.forwardApprovalDecision({
        approvalId,
        decision,
      });
    } catch (err) {
      runtime.error(`[QQ/exec-approvals] Failed to forward decision: ${String(err)}`);
    }
  }

  /**
   * Handle approval request timeout.
   */
  private async handleTimeout(approvalId: string): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;

    this.opts.runtime.info(`[QQ/exec-approvals] Approval ${approvalId} timed out`);

    // Clear timeout tracking
    this.pendingTimeoutIds.delete(approvalId);

    // Remove from pending
    this.pendingApprovals.delete(approvalId);

    // Forward timeout denial to Gateway
    try {
      await this.opts.forwardApprovalDecision({
        approvalId,
        decision: "deny",
      });
    } catch (err) {
      this.opts.runtime.error(`[QQ/exec-approvals] Failed to forward timeout: ${String(err)}`);
    }
  }

  /**
   * Stop the handler and clean up.
   */
  stop(): void {
    // Clear all timeouts
    for (const timeoutId of this.pendingTimeoutIds.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingTimeoutIds.clear();
    this.pendingApprovals.clear();
  }
}

/**
 * Parse an approval response message from QQ.
 * Expected formats:
 * - "approve {approvalId} allow-once"
 * - "approve {approvalId} allow-always"
 * - "approve {approvalId} deny"
 * - "{approvalId} allow-once"
 */
export function parseApprovalResponse(messageText: string): {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
} | null {
  const text = messageText.trim().toLowerCase();

  // Match patterns like "approve abc123 allow-once" or "abc123 allow-once"
  const match = text.match(/^(?:approve\s+)?(\S+)\s+(allow-once|allow-always|deny)$/);
  if (match) {
    return {
      approvalId: match[1],
      decision: match[2] as "allow-once" | "allow-always" | "deny",
    };
  }

  return null;
}

/**
 * Format an approval request message for sending to approvers.
 */
export function formatApprovalRequestMessage(params: {
  approvalId: string;
  commandText: string;
  expiresAt: string;
}): string {
  return [
    `🔔 Execution Approval Request`,
    ``,
    `ID: ${params.approvalId}`,
    `Command: ${params.commandText}`,
    `Expires: ${params.expiresAt}`,
    ``,
    `Reply with:`,
    `  approve ${params.approvalId} allow-once - Allow this once`,
    `  approve ${params.approvalId} allow-always - Allow always`,
    `  approve ${params.approvalId} deny - Deny`,
  ].join("\n");
}
