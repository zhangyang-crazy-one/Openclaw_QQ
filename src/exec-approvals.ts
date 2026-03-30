/**
 * QQ Exec Approvals configuration and types.
 *
 * This module provides configuration parsing for the QQ exec approvals feature,
 * which allows requiring approval before executing certain commands/actions.
 */

import type { QQAccountConfig } from "./types.js";

export type QQExecApprovalConfig = {
  /** Whether exec approvals are enabled */
  enabled?: boolean;
  /** List of approver QQ IDs who can approve requests */
  approvers?: Array<string | number>;
  /** Target for approval requests: "dm", "channel", or "both" */
  target?: "dm" | "channel" | "both";
  /** Filter to only forward approvals for specific agent IDs */
  agentFilter?: string[];
  /** Filter to only forward approvals for sessions matching these patterns */
  sessionFilter?: string[];
};

/** Extend QQ account config with exec approvals */
export type QQAccountConfigWithExecApprovals = QQAccountConfig & {
  execApprovals?: QQExecApprovalConfig;
};

/**
 * Check if exec approvals are enabled for an account.
 */
export function isQqExecApprovalEnabled(params: {
  cfg: Record<string, unknown>;
  accountId: string;
}): boolean {
  const account = getQqExecApprovalAccount(params.cfg, params.accountId);
  return account?.execApprovals?.enabled === true;
}

/**
 * Get the exec approval config for an account.
 */
export function getQqExecApprovalConfig(params: {
  cfg: Record<string, unknown>;
  accountId: string;
}): QQExecApprovalConfig | undefined {
  const account = getQqExecApprovalAccount(params.cfg, params.accountId);
  return account?.execApprovals;
}

/**
 * Get approvers list for an account.
 */
export function getQqExecApprovalApprovers(params: {
  cfg: Record<string, unknown>;
  accountId: string;
}): string[] {
  const config = getQqExecApprovalConfig(params);
  if (!config?.approvers) return [];
  return config.approvers.map((a) => String(a));
}

/**
 * Check if a sender ID is an approver.
 */
export function isQqExecApprovalApprover(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  senderId: string | number;
}): boolean {
  const approvers = getQqExecApprovalApprovers(params);
  const senderIdStr = String(params.senderId);
  return approvers.includes(senderIdStr);
}

/**
 * Resolve the target destination for approval requests.
 */
export function resolveQqExecApprovalTarget(params: {
  cfg: Record<string, unknown>;
  accountId: string;
}): "dm" | "channel" | "both" {
  const config = getQqExecApprovalConfig(params);
  return config?.target ?? "dm";
}

/**
 * Check if a request should be handled based on agent filter.
 */
export function matchesQqExecApprovalAgentFilter(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  agentId?: string;
}): boolean {
  const config = getQqExecApprovalConfig(params);
  if (!config?.agentFilter || config.agentFilter.length === 0) {
    return true; // No filter = match all
  }
  if (!params.agentId) return false;
  return config.agentFilter.includes(params.agentId);
}

/**
 * Check if a request should be handled based on session filter.
 */
export function matchesQqExecApprovalSessionFilter(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  sessionKey?: string;
}): boolean {
  const config = getQqExecApprovalConfig(params);
  if (!config?.sessionFilter || config.sessionFilter.length === 0) {
    return true; // No filter = match all
  }
  if (!params.sessionKey) return false;

  // Simple pattern matching (supports * wildcard)
  for (const pattern of config.sessionFilter) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    if (regex.test(params.sessionKey)) {
      return true;
    }
  }
  return false;
}

// Helper to get account config with exec approvals
function getQqExecApprovalAccount(
  cfg: Record<string, unknown>,
  accountId: string,
): QQAccountConfigWithExecApprovals | undefined {
  const accounts = cfg.accounts as Record<string, unknown> | undefined;
  if (!accounts) return undefined;
  const account = accounts[accountId] as QQAccountConfigWithExecApprovals | undefined;
  return account;
}
