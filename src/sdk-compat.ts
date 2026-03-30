/**
 * QQ Plugin SDK Compatibility Layer
 *
 * This module provides polyfills and re-exports for SDK APIs that were
 * removed or moved in the new OpenClaw SDK version (2026.3.27+).
 *
 * Usage: Import from this module instead of "openclaw/plugin-sdk" for
 * these specific symbols.
 */

import { z } from "zod";

// ============================================================================
// Types for AgentToolResult - import from pi-agent-core
// ============================================================================

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
export type { AgentToolResult } from "@mariozechner/pi-agent-core";

// ============================================================================
// Account ID helpers (removed from index.ts, available in routing/session-key)
// ============================================================================

/**
 * Default account ID constant - used when no specific account is specified.
 * Previously exported from "openclaw/plugin-sdk"
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Normalize an account ID - trim whitespace and convert to lowercase.
 * Previously exported from "openclaw/plugin-sdk"
 */
export function normalizeAccountId(id: string | null | undefined): string {
  if (!id) return DEFAULT_ACCOUNT_ID;
  const trimmed = id.trim();
  return trimmed.length === 0 ? DEFAULT_ACCOUNT_ID : trimmed;
}

// ============================================================================
// Channel config helpers (from compat surface)
// ============================================================================

// Re-export from compat
export {
  createHybridChannelConfigAdapter,
  createHybridChannelConfigBase,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigAdapter,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
  createTopLevelChannelConfigBase,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/compat";

export { formatAllowFromLowercase, formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/compat";

// ============================================================================
// Policy schemas (from channel-config-schema via compat)
// ============================================================================

export { DmPolicySchema, GroupPolicySchema, MarkdownConfigSchema } from "openclaw/plugin-sdk/compat";

// ============================================================================
// Utility functions (removed from SDK - provide local polyfills)
// ============================================================================

/**
 * Create a JSON result object.
 * Previously from "openclaw/plugin-sdk" - returns AgentToolResult shape.
 */
export function jsonResult(data: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Read a number parameter from a params object.
 * Previously from "openclaw/plugin-sdk"
 */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { integer?: boolean; required?: boolean }
): number | undefined {
  const val = params[key];
  if (val === undefined) {
    if (opts?.required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }
  if (typeof val === "number") {
    return opts?.integer ? Math.floor(val) : val;
  }
  if (typeof val === "string") {
    const n = Number(val);
    if (isNaN(n)) return undefined;
    return opts?.integer ? Math.floor(n) : n;
  }
  return undefined;
}

/**
 * Read a string parameter from a params object.
 * Previously from "openclaw/plugin-sdk"
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean }
): string | undefined {
  const val = params[key];
  if (val === undefined) {
    if (opts?.required) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return undefined;
  }
  return typeof val === "string" ? val : undefined;
}

// ============================================================================
// Policy types (re-export from SDK types)
// ============================================================================

export type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";
export type { MarkdownConfig } from "openclaw/plugin-sdk/irc";

// ============================================================================
// Config schema helpers (from SDK)
// ============================================================================

export { emptyPluginConfigSchema } from "openclaw/plugin-sdk/compat";

// ============================================================================
// Channel helpers that may be missing from new SDK
// ============================================================================

/**
 * ChannelConfigSchema type - returned by buildChannelConfigSchema
 */
export interface ChannelConfigSchema {
  schema: Record<string, unknown>;
}

/**
 * Build channel config schema from a Zod schema.
 * Previously exported from "openclaw/plugin-sdk"
 *
 * This function wraps a Zod schema into the OpenClaw ChannelConfigSchema format.
 * It tries to use toJSONSchema() if available (Zod v3), otherwise returns
 * a generic object schema.
 */
export function buildChannelConfigSchema(schema: z.ZodTypeAny): ChannelConfigSchema {
  const schemaWithJson = schema as z.ZodTypeAny & { toJSONSchema?: (params?: Record<string, unknown>) => unknown };
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>,
    };
  }

  // Compatibility fallback for plugins built against Zod v3 schemas
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
  };
}

/**
 * Apply account name to channel section.
 * Polyfill for SDK function that may not exist.
 */
export function applyAccountNameToChannelSection(params: {
  cfg: Record<string, unknown>;
  channelKey: string;
  accountId: string;
  name?: string;
}): Record<string, unknown> {
  const { cfg, channelKey, accountId, name } = params;
  return {
    ...cfg,
    channels: {
      ...((cfg.channels as Record<string, unknown>) || {}),
      [channelKey]: {
        ...(((cfg.channels as Record<string, unknown>) || {})[channelKey] as Record<string, unknown> || {}),
        accounts: {
          ...((((cfg.channels as Record<string, unknown>) || {})[channelKey] as Record<string, unknown>)?.accounts as Record<string, unknown> || {}),
          [accountId]: {
            ...(((((cfg.channels as Record<string, unknown>) || {})[channelKey] as Record<string, unknown>)?.accounts?.[accountId] as Record<string, unknown>) || {}),
            name,
          },
        },
      },
    },
  };
}

// ============================================================================
// Pairing helpers (may not exist in new SDK)
// ============================================================================

export const PAIRING_APPROVED_MESSAGE = "Pairing approved! You can now use this bot.";

/**
 * Format pairing approve hint.
 */
export function formatPairingApproveHint(accountId: string): string {
  return `Pairing request for account ${accountId} approved.`;
}

/**
 * Migrate base name to default account.
 */
export function migrateBaseNameToDefaultAccount(params: {
  cfg: Record<string, unknown>;
  channelKey: string;
}): Record<string, unknown> {
  const { cfg, channelKey } = params;
  // If there's a 'name' at channel level, move it to default account
  const channelConfig = ((cfg.channels as Record<string, unknown>) || {})[channelKey] as Record<string, unknown> | undefined;
  if (!channelConfig) return cfg;

  const { name, accounts, defaultAccount, ...rest } = channelConfig;

  if (name && !defaultAccount) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [channelKey]: {
          ...rest,
          defaultAccount: DEFAULT_ACCOUNT_ID,
          accounts: {
            [DEFAULT_ACCOUNT_ID]: { name },
            ...(accounts as Record<string, unknown>),
          },
        },
      },
    };
  }

  return cfg;
}

/**
 * Delete account from config section.
 * Updated to match SDK signature: { cfg, sectionKey, accountId, clearBaseFields }
 */
export function deleteAccountFromConfigSection(params: {
  cfg: Record<string, unknown>;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): Record<string, unknown> {
  const { cfg, sectionKey, accountId, clearBaseFields } = params;
  const DEFAULT_ACCOUNT_ID_LOCAL = "default";
  const accountKey = accountId || DEFAULT_ACCOUNT_ID_LOCAL;
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[sectionKey] as Record<string, unknown> | undefined;
  if (!base) {
    return cfg;
  }

  const baseAccounts = base.accounts && typeof base.accounts === "object"
    ? { ...(base.accounts as Record<string, Record<string, unknown>>) }
    : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID_LOCAL) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      },
    };
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...base };
    for (const field of clearBaseFields ?? []) {
      if (field in baseRecord) {
        baseRecord[field] = undefined;
      }
    }
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
        },
      },
    };
  }

  return cfg;
}

/**
 * Set account enabled in config section.
 * Updated to match SDK signature: { cfg, sectionKey, accountId, enabled, allowTopLevel }
 */
export function setAccountEnabledInConfigSection(params: {
  cfg: Record<string, unknown>;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): Record<string, unknown> {
  const { cfg, sectionKey, accountId, enabled, allowTopLevel } = params;
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[sectionKey] as Record<string, unknown> | undefined;
  const hasAccounts = Boolean(base?.accounts);
  const DEFAULT_ACCOUNT_ID_LOCAL = "default";

  if (allowTopLevel && accountId === DEFAULT_ACCOUNT_ID_LOCAL && !hasAccounts) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [sectionKey]: {
          ...base,
          enabled,
        },
      },
    };
  }

  const baseAccounts = (base?.accounts as Record<string, Record<string, unknown>>) ?? {};
  const existing = baseAccounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [sectionKey]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountId]: {
            ...existing,
            enabled,
          },
        },
      },
    },
  };
}

// ============================================================================
// Additional types that may be needed (polyfill/missing exports)
// ============================================================================

// ChannelDirectoryEntry - from SDK types.core
export type ChannelDirectoryEntryKind = "user" | "group" | "channel";

// ChannelDirectoryEntry - updated to match SDK interface
export interface ChannelDirectoryEntry {
  kind: ChannelDirectoryEntryKind;
  id: string;
  name?: string;
  handle?: string;
  avatarUrl?: string;
  pictureUrl?: string;
  rank?: number;
}

// ChannelLogSink - logging interface
export interface ChannelLogSink {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
}

// OutboundDeliveryResult - previously from openclaw/plugin-sdk/twitch
export type OutboundDeliveryResult = {
  channel: string;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  meta?: Record<string, unknown>;
};

// ChannelOutboundTargetMode - type for target resolution modes
export type ChannelOutboundTargetMode = "explicit" | "implicit" | "heartbeat";

// Re-export ChannelPlugin which IS exported from new SDK
export type { ChannelPlugin } from "openclaw/plugin-sdk";
