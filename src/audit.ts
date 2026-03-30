/**
 * QQ Group Membership Audit.
 *
 * This module provides functionality to verify that the bot is a member
 * of specified QQ groups, which is useful for access control and verification.
 */

import { getActiveNativeClient } from "./qq-native.js";
import { getActiveQqClient } from "./adapter.js";

export type QQGroupMembershipAuditEntry = {
  /** The QQ group ID */
  chatId: string;
  /** Whether the bot is a valid member (creator, admin, or member) */
  ok: boolean;
  /** The member status if known */
  status?: string | null;
  /** Error message if the check failed */
  error?: string | null;
};

export type QQGroupMembershipAudit = {
  /** Overall audit result */
  ok: boolean;
  /** Number of groups checked */
  checkedGroups: number;
  /** Number of groups where membership is invalid */
  unresolvedGroups: number;
  /** Whether there are wildcard groups that weren't matched */
  hasWildcardUnmentionedGroups: boolean;
  /** Detailed results per group */
  groups: QQGroupMembershipAuditEntry[];
  /** Time taken for the audit in ms */
  elapsedMs: number;
};

/**
 * Audit QQ group membership for the bot account.
 *
 * This verifies that the bot is a valid member (creator, administrator, or member)
 * of the specified groups.
 *
 * @param params.accountId - The QQ account ID
 * @param params.groupIds - List of group IDs to check
 * @param params.timeoutMs - Timeout for the audit in milliseconds
 * @returns Membership audit results
 */
export async function auditQqGroupMembership(params: {
  accountId: string;
  groupIds: string[];
  timeoutMs?: number;
}): Promise<QQGroupMembershipAudit> {
  const started = Date.now();
  const timeout = params.timeoutMs ?? 30000;

  // Try native client first
  const nativeClient = getActiveNativeClient(params.accountId);
  if (nativeClient) {
    return auditViaNative(nativeClient, params.groupIds, started, timeout);
  }

  // Fall back to OB11 client
  const client = getActiveQqClient(params.accountId);
  if (client) {
    return auditViaOb11(client, params.groupIds, started, timeout);
  }

  // No client available
  const elapsedMs = Date.now() - started;
  return {
    ok: false,
    checkedGroups: params.groupIds.length,
    unresolvedGroups: params.groupIds.length,
    hasWildcardUnmentionedGroups: false,
    groups: params.groupIds.map((chatId) => ({
      chatId,
      ok: false,
      error: "No QQ client available",
    })),
    elapsedMs,
  };
}

/**
 * Audit membership via native oicq client.
 */
async function auditViaNative(
  nativeClient: { client: { getGroupInfo?: (groupId: number) => Promise<unknown> } },
  groupIds: string[],
  started: number,
  timeout: number,
): Promise<QQGroupMembershipAudit> {
  const groups: QQGroupMembershipAuditEntry[] = [];
  let unresolvedGroups = 0;

  for (const chatId of groupIds) {
    try {
      const groupIdNum = Number(chatId);
      if (!Number.isFinite(groupIdNum)) {
        groups.push({
          chatId,
          ok: false,
          error: "Invalid group ID",
        });
        unresolvedGroups++;
        continue;
      }

      // oicq's getGroupInfo returns group info including member status
      // The status field indicates the bot's role in the group
      const info = await Promise.race([
        nativeClient.client.getGroupInfo?.(groupIdNum) as Promise<{ member?: { status?: string } }>,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), timeout / groupIds.length),
        ),
      ]);

      if (!info) {
        groups.push({
          chatId,
          ok: false,
          error: "Group not found or timeout",
        });
        unresolvedGroups++;
        continue;
      }

      // Status values: "creator", "admin", "member", "leave", "kick"
      const status = (info as { member?: { status?: string } }).member?.status;
      const ok = status === "creator" || status === "admin" || status === "member";

      groups.push({
        chatId,
        ok,
        status,
        error: ok ? null : status ? `Invalid status: ${status}` : "Not a member",
      });

      if (!ok) unresolvedGroups++;
    } catch (err) {
      groups.push({
        chatId,
        ok: false,
        error: String(err),
      });
      unresolvedGroups++;
    }
  }

  const elapsedMs = Date.now() - started;
  return {
    ok: unresolvedGroups === 0,
    checkedGroups: groupIds.length,
    unresolvedGroups,
    hasWildcardUnmentionedGroups: false,
    groups,
    elapsedMs,
  };
}

/**
 * Audit membership via OB11 client.
 */
async function auditViaOb11(
  client: { sendAction: (action: string, params?: Record<string, unknown>) => Promise<unknown> },
  groupIds: string[],
  started: number,
  timeout: number,
): Promise<QQGroupMembershipAudit> {
  const groups: QQGroupMembershipAuditEntry[] = [];
  let unresolvedGroups = 0;

  for (const chatId of groupIds) {
    try {
      const response = await Promise.race([
        client.sendAction("get_group_info", { group_id: chatId }),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), timeout / groupIds.length),
        ),
      ]);

      const resp = response as { status?: string; data?: { group_id?: number; member?: { role?: string } } };
      if (!resp || resp.status !== "ok") {
        groups.push({
          chatId,
          ok: false,
          error: "Failed to get group info",
        });
        unresolvedGroups++;
        continue;
      }

      // Role values: "owner", "admin", "member"
      const role = resp.data?.member?.role;
      const ok = role === "owner" || role === "admin" || role === "member";

      groups.push({
        chatId,
        ok,
        status: role,
        error: ok ? null : role ? `Invalid role: ${role}` : "Not a member",
      });

      if (!ok) unresolvedGroups++;
    } catch (err) {
      groups.push({
        chatId,
        ok: false,
        error: String(err),
      });
      unresolvedGroups++;
    }
  }

  const elapsedMs = Date.now() - started;
  return {
    ok: unresolvedGroups === 0,
    checkedGroups: groupIds.length,
    unresolvedGroups,
    hasWildcardUnmentionedGroups: false,
    groups,
    elapsedMs,
  };
}
