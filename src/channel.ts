import type { ChannelPlugin, RuntimeLogger } from "openclaw/plugin-sdk";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ChannelSetupInput } from "openclaw/plugin-sdk";
import { qqSetupWizard } from "./channel.setup.js";
import type { ChannelDirectoryEntry, ChannelLogSink } from "./sdk-compat.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
} from "./sdk-compat.js";
import type { Ob11Client } from "./adapter.js";
import type { OB11ActionResponse, QQConnectionConfig, QQNativeConnectionConfig, ResolvedQQAccount } from "./types.js";
import { clearActiveQqClient, getActiveQqClient, startQqClient } from "./adapter.js";
import {
  clearActiveNativeClient,
  getActiveNativeClient,
  startQqNativeClient,
} from "./qq-native.js";
import { QQConfigSchema } from "./config-schema.js";
import {
  isConnectionConfigured,
  listQqAccountIds,
  resolveConnectionIssue,
  resolveDefaultQqAccountId,
  resolveQqAccount,
} from "./config.js";
import { handleOb11Event } from "./inbound.js";
import { qqOutbound } from "./outbound.js";
import { qqMessageActions } from "./actions.js";
import { setQqRuntime } from "./runtime.js";
import { rememberSelfSentResponse } from "./self-sent.js";
import { sendOb11Message } from "./send.js";
import { formatQqTarget, normalizeAllowEntry, parseQqTarget } from "./targets.js";

const CHANNEL_ID = "qq";

const meta = {
  id: "qq",
  label: "QQ",
  selectionLabel: "QQ (OneBot 11)",
  docsPath: "/channels/qq",
  docsLabel: "qq",
  blurb: "QQ via OneBot 11 backends (LLOneBot/napcat/go-cqhttp).",
  order: 90,
  quickstartAllowFrom: true,
};

function normalizeQqMessagingTarget(raw: string): string | undefined {
  const parsed = parseQqTarget(raw);
  if (!parsed) return undefined;
  return formatQqTarget(parsed);
}

function resolveConnectionBaseUrl(connection?: QQConnectionConfig): string | undefined {
  if (!connection) return undefined;
  if (connection.type === "ws" || connection.type === "http") {
    const host = connection.host?.trim();
    const port = connection.port;
    if (!host || !port) return undefined;
    const protocol =
      connection.type === "ws"
        ? connection.secure
          ? "wss"
          : "ws"
        : connection.secure
          ? "https"
          : "http";
    return `${protocol}://${host}:${port}`;
  }
  return undefined;
}

function resolveLogger(runtime: RuntimeEnv, log?: ChannelLogSink): RuntimeLogger {
  if (log) {
    return {
      info: log.info ? (message: string) => log.info!(message) : (message: string) => runtime.log(message),
      warn: log.warn ? (message: string) => log.warn!(message) : (message: string) => runtime.log(message),
      error: log.error ? (message: string) => log.error!(message) : (message: string) => runtime.error(message),
      debug: log.debug ? (message: string) => log.debug!(message) : undefined,
    };
  }
  return {
    info: (message: string) => runtime.log(message),
    warn: (message: string) => runtime.log(message),
    error: (message: string) => runtime.error(message),
  };
}

function parsePort(value?: string | number): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseConnectionInput(input: ChannelSetupInput): {
  connection?: QQConnectionConfig;
  error?: string;
} {
  const rawUrl = input.url?.trim() || input.httpUrl?.trim();
  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { error: "Connection URL is invalid." };
    }
    const protocol = parsed.protocol.replace(":", "");
    const host = parsed.hostname.trim();
    const port =
      parsePort(parsed.port) ??
      (protocol === "https" || protocol === "wss" ? 443 : protocol ? 80 : null);
    if (!host) return { error: "Connection URL must include a host." };
    if (!port) return { error: "Connection URL must include a port." };
    if (protocol === "http" || protocol === "https") {
      return {
        connection: {
          type: "http",
          host,
          port,
          secure: protocol === "https",
          token: input.token?.trim() || undefined,
        },
      };
    }
    if (protocol === "ws" || protocol === "wss") {
      return {
        connection: {
          type: "ws",
          host,
          port,
          secure: protocol === "wss",
          token: input.token?.trim() || undefined,
        },
      };
    }
    return { error: "Connection URL must start with http(s):// or ws(s)://." };
  }

  if (input.httpHost || input.httpPort) {
    const host = input.httpHost?.trim();
    const port = parsePort(input.httpPort);
    if (!host) return { error: "HTTP host is required." };
    if (!port) return { error: "HTTP port must be a number." };
    return {
      connection: {
        type: "http",
        host,
        port,
        secure: false,
        token: input.token?.trim() || undefined,
      },
    };
  }

  return {};
}

function applyConnectionConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  connection: QQConnectionConfig;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels ?? {};
  const base = (channels.qq ?? {}) as Record<string, unknown>;
  const baseAccounts =
    base.accounts && typeof base.accounts === "object"
      ? (base.accounts as Record<string, Record<string, unknown>>)
      : undefined;
  const useAccounts = accountId !== DEFAULT_ACCOUNT_ID || Boolean(baseAccounts);
  const baseConfig = useAccounts ? (({ connection: _ignored, ...rest }) => rest)(base) : base;

  if (!useAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...channels,
        qq: {
          ...baseConfig,
          enabled: true,
          connection: params.connection,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = { ...(baseAccounts ?? {}) };
  const existing = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...channels,
      qq: {
        ...baseConfig,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...existing,
            enabled: true,
            connection: params.connection,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function resolveOutboundAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  if (accountId?.trim()) return accountId.trim();
  return resolveDefaultQqAccountId(cfg);
}

function requireActiveClient(params: { cfg: OpenClawConfig; accountId?: string | null }): {
  accountId: string;
  client: Ob11Client;
} {
  const accountId = resolveOutboundAccountId(params.cfg, params.accountId);
  const client = getActiveQqClient(accountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${accountId}`);
  }
  return { accountId, client };
}

/** Get the logged-in user's info from either native or OB11 client. */
async function getSelfInfoFromClient(accountId: string): Promise<{ userId: number; nickname?: string } | null> {
  // Try native client first
  const { getActiveNativeClient } = await import("./qq-native.js");
  const nativeClient = getActiveNativeClient(accountId);
  if (nativeClient) {
    try {
      const info = await nativeClient.client.getLoginInfo();
      if (info) {
        return { userId: nativeClient.getUin(), nickname: info.nickname };
      }
    } catch {
      // Fall through to OB11
    }
  }

  // OB11 client
  const client = getActiveQqClient(accountId);
  if (!client) return null;
  const response = await client.sendAction("get_login_info");
  if (!isActionOk(response)) return null;
  const data = response.data as Record<string, unknown> | undefined;
  const userId = data?.user_id ?? data?.userId;
  if (userId == null) return null;
  const nickname = typeof data?.nickname === "string" ? data.nickname.trim() : undefined;
  return { userId: Number(userId), nickname };
}

/** Get friend list from either native or OB11 client. */
async function getFriendListFromClient(accountId: string): Promise<Array<{ userId: number; nickname?: string; remark?: string }>> {
  // Try native client first
  const { getActiveNativeClient } = await import("./qq-native.js");
  const nativeClient = getActiveNativeClient(accountId);
  if (nativeClient) {
    try {
      const list = await nativeClient.client.getFriendList();
      return list.map((f: { uin: number; nickname?: string; remark?: string }) => ({
        userId: f.uin,
        nickname: f.nickname,
        remark: f.remark,
      }));
    } catch {
      // Fall through to OB11
    }
  }

  // OB11 client
  const client = getActiveQqClient(accountId);
  if (!client) return [];
  const response = await client.sendAction("get_friend_list");
  if (!isActionOk(response)) return [];
  return (Array.isArray(response.data) ? response.data : []).map((item) => ({
    userId: item.user_id ?? item.userId!,
    nickname: item.nickname,
    remark: item.remark,
  }));
}

/** Get group list from either native or OB11 client. */
async function getGroupListFromClient(accountId: string): Promise<Array<{ groupId: number; groupName?: string }>> {
  // Try native client first
  const { getActiveNativeClient } = await import("./qq-native.js");
  const nativeClient = getActiveNativeClient(accountId);
  if (nativeClient) {
    try {
      const list = await nativeClient.client.getGroupList();
      return list.map((g: { group_id: number; group_name?: string }) => ({
        groupId: g.group_id,
        groupName: g.group_name,
      }));
    } catch {
      // Fall through to OB11
    }
  }

  // OB11 client
  const client = getActiveQqClient(accountId);
  if (!client) return [];
  const response = await client.sendAction("get_group_list");
  if (!isActionOk(response)) return [];
  return (Array.isArray(response.data) ? response.data : []).map((item) => ({
    groupId: item.group_id ?? item.groupId!,
    groupName: item.group_name ?? item.groupName,
  }));
}

function isActionOk(response: OB11ActionResponse): boolean {
  if (response.status) return response.status === "ok";
  if (typeof response.retcode === "number") return response.retcode === 0;
  return true;
}

function resolveActionError(response: OB11ActionResponse): string {
  if (response.msg) return response.msg;
  if (typeof response.retcode === "number") return `retcode=${response.retcode}`;
  return "action failed";
}

export const qqPlugin: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta,
  pairing: {
    idLabel: "qqUserId",
    normalizeAllowEntry,
    notifyApproval: async ({ cfg, id, runtime }) => {
      const accountId = resolveDefaultQqAccountId(cfg);
      const client = getActiveQqClient(accountId);
      if (!client) {
        runtime?.log?.(`qq: unable to notify ${id} (client not running)`);
        return;
      }
      const response = await sendOb11Message({
        client,
        target: { kind: "private", id },
        text: PAIRING_APPROVED_MESSAGE,
      });
      rememberSelfSentResponse({
        accountId,
        response,
        target: formatQqTarget({ kind: "private", id }),
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    polls: false,
    reactions: true,
    threads: false,
    nativeCommands: true,
    groupManagement: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qq"] },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => listQqAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQqAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultQqAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qq",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qq",
        accountId,
        clearBaseFields: [
          "name",
          "markdown",
          "connection",
          "allowFrom",
          "groupAllowFrom",
          "dmPolicy",
          "groupPolicy",
          "requireMention",
          "groups",
          "defaultAccount",
        ],
      }),
    isConfigured: (account) => isConnectionConfigured(account.connection),
    unconfiguredReason: (account) => resolveConnectionIssue(account.connection) ?? "not configured",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      mode: account.connection?.type,
      baseUrl: resolveConnectionBaseUrl(account.connection),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveQqAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map(normalizeAllowEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const qqConfig = cfg.channels?.qq as Record<string, unknown> | undefined;
      const qqAccounts = qqConfig?.accounts as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(qqAccounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.qq.accounts.${resolvedAccountId}.`
        : "channels.qq.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint(CHANNEL_ID),
        normalizeEntry: normalizeAllowEntry,
      };
    },
    collectWarnings: ({ cfg, account }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      const groupAllowlist = account.config.groupAllowFrom ?? [];
      if (groupPolicy !== "open") return [];
      if (groupAllowlist.length > 0) {
        return [
          '- QQ groups: groupPolicy="open" allows any group to trigger (mention-gated). Set channels.qq.groupPolicy="allowlist" and channels.qq.groupAllowFrom to restrict groups.',
        ];
      }
      return [
        '- QQ groups: groupPolicy="open" with no group allowlist allows any group to trigger (mention-gated). Set channels.qq.groupPolicy="allowlist" and channels.qq.groupAllowFrom to restrict groups.',
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) =>
      resolveQqAccount({ cfg, accountId }).config.requireMention ?? true,
  },
  messaging: {
    normalizeTarget: normalizeQqMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (/^qq:/i.test(trimmed)) return true;
        if (/^(group|g|user):/i.test(trimmed)) return true;
        return /^\d{3,}$/.test(trimmed);
      },
      hint: "<qqId | group:groupId>",
    },
  },
  outbound: qqOutbound,
  actions: qqMessageActions,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: CHANNEL_ID,
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      mode: account.connection?.type,
      baseUrl: resolveConnectionBaseUrl(account.connection),
      dmPolicy: account.config.dmPolicy ?? "pairing",
      allowFrom: (account.config.allowFrom ?? []).map((entry) =>
        normalizeAllowEntry(String(entry)),
      ),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
      const info = await getSelfInfoFromClient(resolvedAccountId);
      if (!info) return null;
      return {
        kind: "user",
        id: String(info.userId),
        name: info.nickname,
      };
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
      const friends = await getFriendListFromClient(resolvedAccountId);
      const q = query?.trim().toLowerCase() ?? "";
      const entries = friends
        .map((entry) => ({
          id: entry.userId,
          nickname: entry.remark ?? entry.nickname ?? "",
        }))
        .filter((entry) => entry.id != null)
        .map((entry) => ({
          kind: "user" as const,
          id: String(entry.id),
          name: entry.nickname ? String(entry.nickname).trim() : undefined,
        }))
        .filter((entry) => {
          if (!q) return true;
          return (
            entry.id.toLowerCase().includes(q) || (entry.name?.toLowerCase().includes(q) ?? false)
          );
        });
      if (limit && limit > 0) return entries.slice(0, limit);
      return entries;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);
      const groups = await getGroupListFromClient(resolvedAccountId);
      const q = query?.trim().toLowerCase() ?? "";
      const entries = groups
        .map((entry) => ({
          id: entry.groupId,
          name: entry.groupName ?? "",
        }))
        .filter((entry) => entry.id != null)
        .map((entry) => ({
          kind: "group" as const,
          id: String(entry.id),
          name: entry.name ? String(entry.name).trim() : undefined,
        }))
        .filter((entry) => {
          if (!q) return true;
          return (
            entry.id.toLowerCase().includes(q) || (entry.name?.toLowerCase().includes(q) ?? false)
          );
        });
      if (limit && limit > 0) return entries.slice(0, limit);
      return entries;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qq",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      const { connection, error } = parseConnectionInput(input);
      if (error) return error;
      if (!connection) {
        return "QQ requires a connection URL or --http-host/--http-port.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "qq",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "qq",
            })
          : namedConfig;
      const parsed = parseConnectionInput(input);
      if (!parsed.connection) return next;
      return applyConnectionConfig({
        cfg: next,
        accountId,
        connection: parsed.connection,
      });
    },
  },
  setupWizard: qqSetupWizard,
    gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const connection = account.connection;
      if (!connection) {
        throw new Error("QQ connection not configured");
      }

      const logger = resolveLogger(ctx.runtime, ctx.log);

      if (connection.type === "native") {
        // Native oicq client (no external bot service needed)
        const nativeConfig = connection as QQNativeConnectionConfig;
        logger.info(`[${account.accountId}] Starting QQ native client for uin ${nativeConfig.uin}`);

        const isQrLogin = nativeConfig.qrLogin ?? !nativeConfig.password;

        await startQqNativeClient({
          accountId: account.accountId,
          config: {
            uin: nativeConfig.uin,
            password: nativeConfig.password,
            qrLogin: isQrLogin,
            platform: nativeConfig.platform,
            dataDir: nativeConfig.dataDir,
          },
          abortSignal: ctx.abortSignal,
          callbacks: {
            log: logger,
            onEvent: (event) =>
              handleOb11Event({
                event,
                account,
                config: ctx.cfg,
                runtime: ctx.runtime,
                statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
              }),
            onLoginSuccess: (userId) => {
              logger.info(`[${account.accountId}] QQ native login success: ${userId}`);
            },
            onQrCode: async (data) => {
              logger.info(`[${account.accountId}] QR code received (url: ${data.url ?? "none"})`);

              // If QR login, trigger TUI to display QR code and wait for completion
              if (isQrLogin) {
                try {
                  const { runNativeLoginTui } = await import("./qq-tui-impl.js");
                  await runNativeLoginTui(
                    account.accountId,
                    ctx.runtime,
                    (userId) => {
                      logger.info(`[${account.accountId}] User ${userId} logged in via QR`);
                      ctx.setStatus({ accountId: account.accountId, lastStartAt: Date.now() });
                    },
                    (reason) => {
                      logger.error(`[${account.accountId}] QR login failed: ${reason ?? "unknown"}`);
                    },
                  );
                } catch (err) {
                  logger.error(`[${account.accountId}] Failed to start TUI: ${String(err)}`);
                }
              }
            },
            onLoginError: (message) => {
              logger.error(`[${account.accountId}] QQ native login error: ${message}`);
            },
            onDisconnect: (reason) => {
              logger.warn(`[${account.accountId}] QQ native disconnected: ${reason}`);
            },
          },
        });

        logger.info(`[${account.accountId}] QQ native client started`);

        // Keep startAccount from resolving so gateway doesn't think channel exited.
        // The client runs in background and reconnect is handled by adapter.ts close handlers.
        await new Promise(() => {});
      } else {
        // OB11 client (ws/http) - external bot service required
        await startQqClient({
          accountId: account.accountId,
          connection,
          log: logger,
          abortSignal: ctx.abortSignal,
          onEvent: (event) =>
            handleOb11Event({
              event,
              account,
              config: ctx.cfg,
              runtime: ctx.runtime,
              statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
            }),
        });

        ctx.log?.info(
          `[${account.accountId}] QQ client connected (${resolveConnectionBaseUrl(connection) ?? connection.type})`,
        );

        // Keep startAccount from resolving so gateway doesn't think channel exited.
        // The client runs in background and reconnect is handled by adapter.ts close handlers.
        await new Promise(() => {});
      }
    },
    stopAccount: async ({ cfg, accountId }) => {
      const resolvedAccountId = resolveOutboundAccountId(cfg, accountId);

      // Try native client first, then fall back to OB11 client
      const nativeClient = getActiveNativeClient(resolvedAccountId);
      if (nativeClient) {
        nativeClient.stop();
        clearActiveNativeClient(resolvedAccountId);
        return;
      }

      const ob11Client = getActiveQqClient(resolvedAccountId);
      if (ob11Client) {
        ob11Client.stop();
        clearActiveQqClient(resolvedAccountId);
      }
    },
  },
};
