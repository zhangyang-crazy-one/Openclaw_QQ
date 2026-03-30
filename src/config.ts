import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./sdk-compat.js";
import type { QQAccountConfig, QQConfig, QQConnectionConfig, ResolvedQQAccount } from "./types.js";

export interface ResolvedGroupConfig {
  requireMention: boolean;
  agentId?: string;
  enabled: boolean;
}

export function resolveGroupConfig(
  accountCfg: QQAccountConfig,
  groupId: string,
): ResolvedGroupConfig {
  const specific = accountCfg.groups?.[groupId];
  const wildcard = accountCfg.groups?.["*"];
  return {
    requireMention: specific?.requireMention ?? wildcard?.requireMention ?? accountCfg.requireMention ?? true,
    agentId: specific?.agentId ?? wildcard?.agentId,
    enabled: specific?.enabled ?? wildcard?.enabled ?? true,
  };
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.qq as QQConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listQqAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultQqAccountId(cfg: OpenClawConfig): string {
  const qqConfig = cfg.channels?.qq as QQConfig | undefined;
  if (qqConfig?.defaultAccount?.trim()) return qqConfig.defaultAccount.trim();
  const ids = listQqAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: OpenClawConfig, accountId: string): QQAccountConfig | undefined {
  const accounts = (cfg.channels?.qq as QQConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as QQAccountConfig | undefined;
}

function mergeQqAccountConfig(cfg: OpenClawConfig, accountId: string): QQAccountConfig {
  const raw = (cfg.channels?.qq ?? {}) as QQConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

const SUPPORTED_CONNECTION_TYPES = new Set<QQConnectionConfig["type"]>(["ws", "http", "native"]);

export function isConnectionConfigured(connection?: QQConnectionConfig): boolean {
  if (!connection) return false;
  if (!SUPPORTED_CONNECTION_TYPES.has(connection.type)) return false;
  if (connection.type === "ws" || connection.type === "http") {
    return Boolean(connection.host && connection.port);
  }
  if (connection.type === "native") {
    return Boolean(connection.uin);
  }
  return true;
}

export function resolveConnectionIssue(connection?: QQConnectionConfig): string | null {
  if (!connection) return "missing connection";
  if (!SUPPORTED_CONNECTION_TYPES.has(connection.type)) {
    return `connection type not supported yet: ${connection.type}`;
  }
  if (connection.type === "ws" || connection.type === "http") {
    if (!connection.host?.trim()) return "connection host is missing";
    if (!connection.port) return "connection port is missing";
  }
  if (connection.type === "native") {
    if (!connection.uin) return "QQ uin (account number) is required for native login";
  }
  return null;
}

export function resolveQqAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedQQAccount {
  const qqConfig = params.cfg.channels?.qq as QQConfig | undefined;
  let accountId = normalizeAccountId(params.accountId);
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    const configuredDefault = qqConfig?.defaultAccount?.trim();
    if (configuredDefault) {
      accountId = configuredDefault;
    }
  }
  const baseEnabled = qqConfig?.enabled !== false;
  const merged = mergeQqAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const connection = merged.connection;
  const configured = isConnectionConfigured(connection);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    config: merged,
    connection,
  };
}

export function listEnabledQqAccounts(cfg: OpenClawConfig): ResolvedQQAccount[] {
  return listQqAccountIds(cfg)
    .map((accountId) => resolveQqAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
