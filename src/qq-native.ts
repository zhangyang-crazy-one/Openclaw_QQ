/**
 * QQ native protocol implementation via oicq.
 *
 * This module provides a native QQ client that connects directly to QQ servers
 * without requiring an external OneBot 11 backend (LLBot/napcat).
 *
 * oicq is a pure JavaScript implementation of the QQ protocol, supporting:
 * - Password login
 * - QR code login
 * - Device token persistence
 * - Group/private message sending and receiving
 */

import { createClient, type Client } from "oicq";
import type { OB11Event } from "./types.js";

// Re-export login state types for use by qq-tui.ts
export type { QqLoginState, QqQrCodeData } from "./qq-tui.js";

// Token storage path is managed by oicq internally using the uin as identifier

export type QqNativeConfig = {
  /** QQ account number (uin). */
  uin: number;
  /** Login password (only needed for password login, not QR). */
  password?: string;
  /** Device/platform identifier. Default: 2 (Android). */
  platform?: number;
  /** Whether to log in via QR code instead of password. */
  qrLogin?: boolean;
  /** Data directory for storing login tokens/session. Defaults to ~/.oicq. */
  dataDir?: string;
};

type QqNativeEventMap = {
  "login.success": { userId: number };
  "login.qrcode": { qrcode: string; imageData?: string; url?: string };
  "login.waiting": Record<string, never>;
  "login.error": { message: string };
  "message": OB11Event;
  "disconnect": { reason: string };
};

type QqNativeEventHandler<K extends keyof QqNativeEventMap> = (
  data: QqNativeEventMap[K],
) => void | Promise<void>;

type RuntimeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const NATIVE_TO_OB11_POST_TYPE: Record<string, string> = {
  message: "message",
  "message.private": "message",
  "message.group": "message",
  "system.login.qrcode": "meta_event",
  "system.login.device": "meta_event",
  "system.offline": "meta_event",
};

// Reconnection configuration
const RECONNECT_DELAYS_MS = [3000, 10000, 30000, 60000];
const MAX_RECONNECT_ATTEMPTS = 5;

/** Check if an offline reason is recoverable (network issue, not permanent failure) */
function isRecoverableOffline(subType: string | number | undefined): boolean {
  // Network-related disconnect codes that are recoverable
  const recoverableCodes = ["network", "timeout", "kicked", "bandage", 1, 2, 3, 4, 5];
  if (subType === undefined) return true; // Unknown reason, assume recoverable
  return recoverableCodes.includes(subType);
}

/**
 * Convert oicq event to OB11Event format for compatibility with existing inbound handling.
 */
function oicqEventToOb11(event: OicqEvent): OB11Event {
  const postType = NATIVE_TO_OB11_POST_TYPE[event.post_type] ?? event.post_type;

  // Build a partial OB11Event with the fields we can infer
  const base: OB11Event = {
    post_type: postType,
    time: Math.floor(Date.now() / 1000),
    self_id: event.user_id,
  } as OB11Event;

  if (postType === "message") {
    // oicq message events have: user_id, group_id, message, font, sender, etc.
    const msgEvent = event as OicqMessageEvent;
    return {
      ...base,
      message_type: msgEvent.group_id ? "group" : "private",
      sub_type: msgEvent.sub_type ?? "normal",
      user_id: msgEvent.user_id,
      group_id: msgEvent.group_id,
      message_id: msgEvent.message_id,
      message: msgEvent.message,
      raw_message: typeof msgEvent.message === "string"
        ? msgEvent.message
        : JSON.stringify(msgEvent.message),
      font: msgEvent.font,
      sender: msgEvent.sender,
    } as OB11Event;
  }

  if (postType === "meta_event") {
    const metaEvent = event as OicqMetaEvent;
    return {
      ...base,
      meta_event_type: metaEvent.meta_event_type,
      sub_type: metaEvent.sub_type,
      status: metaEvent.status,
    } as OB11Event;
  }

  return base;
}

interface OicqEvent {
  post_type: string;
  user_id?: number;
  group_id?: number;
  message_id?: number;
  message?: unknown;
  sub_type?: string;
  font?: number;
  sender?: Record<string, unknown>;
  meta_event_type?: string;
  status?: string;
}

interface OicqMessageEvent extends OicqEvent {
  post_type: "message";
  message_type: "private" | "group";
  user_id: number;
  group_id?: number;
  message: string | unknown[];
  message_id: number;
  font: number;
  sender: {
    user_id: number;
    nickname?: string;
    card?: string;
    role?: string;
    title?: string;
  };
}

interface OicqMetaEvent extends OicqEvent {
  post_type: "meta_event";
  meta_event_type: string;
  sub_type?: string;
  status?: string;
}

const activeNativeClients = new Map<string, Client>();

export type QqNativeClient = {
  /** Unique identifier for this client instance. */
  accountId: string;
  /** The underlying oicq client (for sending actions). */
  client: Client;
  /** Stop the client and clean up. */
  stop: () => void;
  /**
   * Send a group message.
   * @returns Message ID
   */
  sendGroupMsg: (groupId: number, content: string | number) => Promise<number>;
  /**
   * Send a private message.
   * @returns Message ID
   */
  sendPrivateMsg: (userId: number, content: string | number) => Promise<number>;
  /**
   * Delete a message.
   */
  deleteMsg: (messageId: number) => Promise<void>;
  /**
   * Get the UIN (QQ number) of the logged-in account.
   */
  getUin: () => number;
};

/** Track login state for TUI access. */
type LoginState =
  | { phase: "waiting" }
  | { phase: "qr-received"; qrcode: string; imageData?: string; url?: string }
  | { phase: "scanned" }
  | { phase: "confirming" }
  | { phase: "connected"; userId: number }
  | { phase: "error"; message: string };

const loginStates = new Map<string, LoginState>();

export function getLoginState(accountId: string): LoginState {
  return loginStates.get(accountId) ?? { phase: "waiting" };
}

export function setLoginState(accountId: string, state: LoginState): void {
  loginStates.set(accountId, state);
}

export function getActiveNativeClient(accountId: string): QqNativeClient | undefined {
  const client = activeNativeClients.get(accountId);
  if (!client) return undefined;
  return {
    accountId,
    client,
    stop: () => {
      client.logout();
      activeNativeClients.delete(accountId);
      loginStates.delete(accountId);
    },
    sendGroupMsg: (groupId, content) => client.sendGroupMsg(groupId, content),
    sendPrivateMsg: (userId, content) => client.sendPrivateMsg(userId, content),
    deleteMsg: (messageId) => client.deleteMsg(messageId),
    getUin: () => client.uin,
  };
}

export function clearActiveNativeClient(accountId: string): void {
  const existing = activeNativeClients.get(accountId);
  if (existing) {
    existing.logout();
    activeNativeClients.delete(accountId);
  }
}

type QqNativeCallbacks = {
  onEvent: (event: OB11Event) => void;
  onLoginSuccess?: (userId: number) => void;
  onQrCode?: (data: { qrcode: string; imageData?: string; url?: string }) => void;
  onLoginError?: (message: string) => void;
  onDisconnect?: (reason: string) => void;
  log: RuntimeLogger;
};

/**
 * Create and start a native QQ client using oicq.
 *
 * @param params.accountId - OpenClaw account identifier
 * @param params.config - QQ login configuration
 * @param params.callbacks - Event handlers and logger
 * @param params.abortSignal - Signal to cancel the connection
 */
export async function startQqNativeClient(params: {
  accountId: string;
  config: QqNativeConfig;
  callbacks: QqNativeCallbacks;
  abortSignal: AbortSignal;
}): Promise<QqNativeClient> {
  const { accountId, config, callbacks, abortSignal } = params;
  const { log } = callbacks;

  // Validate config
  if (!config.uin) {
    throw new Error("QQ uin is required for native login");
  }

  // Check abort signal BEFORE creating client to avoid resource leaks
  if (abortSignal.aborted) {
    throw new Error("QQ native client startup aborted");
  }

  log.info(`[QQ/native] Creating oicq client for uin ${config.uin}`);

  const client = createClient(config.uin, {
    platform: config.platform ?? 2, // Default to Android
    log_level: "debug",
    // oicq stores data in ~/.oicq by default
  });

  // Register client immediately, but set up abort cleanup
  activeNativeClients.set(accountId, client);

  // Clean up on abort
  abortSignal.addEventListener("abort", () => {
    log.info(`[QQ/native] Abort requested, cleaning up client for ${accountId}`);
    client.logout();
    activeNativeClients.delete(accountId);
    loginStates.delete(accountId);
  });

  // Set up event handlers
  client.on("system.login.qrcode", (data) => {
    log.info("[QQ/native] QR code login initiated");
    log.debug?.(`[QQ/native] QR data: ${JSON.stringify(data)}`);

    // oicq provides qrcode string (for ASCII rendering) and imageBuffer (base64 PNG)
    const qrData = {
      qrcode: data.qrcode ?? "",
      imageData: data.imageBuffer
        ? `data:image/png;base64,${data.imageBuffer.toString("base64")}`
        : undefined,
      url: data.url,
    };

    // Update login state for TUI
    setLoginState(accountId, { phase: "qr-received", ...qrData });

    callbacks.onQrCode?.(qrData);

    // Also emit as OB11 meta event for consistency
    callbacks.onEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      sub_type: "login.qrcode",
      time: Math.floor(Date.now() / 1000),
      status: "qrcode",
      self_id: config.uin,
    } as unknown as OB11Event);
  });

  client.on("system.login.device", (data) => {
    log.warn(`[QQ/native] Device verification required: ${JSON.stringify(data)}`);
    log.info("[QQ/native] Please confirm the device login on your QQ app");

    // Update login state
    setLoginState(accountId, { phase: "waiting" });

    callbacks.onEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      sub_type: "login.device",
      time: Math.floor(Date.now() / 1000),
      status: "device_verify",
      self_id: config.uin,
    } as unknown as OB11Event);
  });

  client.on("system.login.error", (data) => {
    const message = `Login error: code=${data.code}, message=${data.message}`;
    log.error(`[QQ/native] ${message}`);

    // Update login state
    setLoginState(accountId, { phase: "error", message });

    callbacks.onLoginError?.(message);

    callbacks.onEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      sub_type: "login.error",
      time: Math.floor(Date.now() / 1000),
      status: `error:${data.code}`,
      self_id: config.uin,
    } as unknown as OB11Event);
  });

  client.on("system.offline", (data) => {
    const reason = `Offline: code=${data.sub_type}, message=${data.message}`;
    log.warn(`[QQ/native] ${reason}`);

    // Update login state
    setLoginState(accountId, { phase: "error", message: reason });

    callbacks.onDisconnect?.(reason);

    callbacks.onEvent({
      post_type: "meta_event",
      meta_event_type: "offline",
      sub_type: String(data.sub_type),
      time: Math.floor(Date.now() / 1000),
      self_id: config.uin,
    } as unknown as OB11Event);

    // Schedule reconnection if recoverable
    if (isRecoverableOffline(data.sub_type)) {
      log.info(`[QQ/native] Scheduling reconnect for account ${accountId}`);
      // Note: The caller should handle actual reconnection by calling scheduleReconnect
      // This event notifies that a reconnect may be needed
    }
  });

  client.on("online", (data) => {
    log.info(`[QQ/native] Logged in as ${data.user_id}`);

    // Update login state
    setLoginState(accountId, { phase: "connected", userId: data.user_id });
    callbacks.onLoginSuccess?.(data.user_id);

    callbacks.onEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      sub_type: "online",
      time: Math.floor(Date.now() / 1000),
      status: "online",
      self_id: data.user_id,
    } as unknown as OB11Event);
  });

  // Map oicq message events to OB11 format and emit
  client.on("message", (msg) => {
    const ob11Event: OB11Event = {
      post_type: "message",
      message_type: msg.group_id ? "group" : "private",
      sub_type: "normal",
      time: msg.time ?? Math.floor(Date.now() / 1000),
      self_id: client.uin,
      user_id: msg.user_id,
      group_id: msg.group_id,
      message_id: msg.message_id,
      message: msg.message,
      raw_message:
        typeof msg.message === "string"
          ? msg.message
          : JSON.stringify(msg.message),
      font: msg.font,
      sender: {
        user_id: msg.user_id,
        nickname: msg.nickname,
        card: (msg as { card?: string }).card,
      },
    };

    callbacks.onEvent(ob11Event);
  });

  client.on("system", (data) => {
    log.debug?.(`[QQ/native] System event: ${JSON.stringify(data)}`);
  });

  client.on("sync", (data) => {
    log.debug?.(`[QQ/native] Sync: ${JSON.stringify(data)}`);
  });

  client.on("error", (err) => {
    log.error(`[QQ/native] Client error: ${String(err)}`);
    callbacks.onDisconnect?.(String(err));
  });

  // Start login
  // Validate login method BEFORE registering client
  const isQrLogin = config.qrLogin ?? !config.password;
  if (!isQrLogin && !config.password) {
    // Clean up registered client before throwing
    activeNativeClients.delete(accountId);
    throw new Error("Either password or qrLogin=true must be specified");
  }

  if (isQrLogin) {
    log.info("[QQ/native] Starting QR code login...");
    client.login(); // No password = QR login mode
  } else {
    log.info("[QQ/native] Starting password login...");
    client.login(config.password!);
  }

  return {
    accountId,
    client,
    stop: () => {
      log.info(`[QQ/native] Stopping client for account ${accountId}`);
      client.logout();
      activeNativeClients.delete(accountId);
    },
    sendGroupMsg: (groupId, content) => client.sendGroupMsg(groupId, content),
    sendPrivateMsg: (userId, content) => client.sendPrivateMsg(userId, content),
    deleteMsg: (messageId) => client.deleteMsg(messageId),
    getUin: () => client.uin,
  };
}

/** Reconnect state tracking per account */
const reconnectAttempts = new Map<string, number>();

/**
 * Schedule a reconnection attempt for an account.
 * Uses exponential backoff with jitter.
 *
 * @param accountId - The account to reconnect
 * @param config - The QQ login configuration
 * @param callbacks - Event handlers and logger
 * @param attemptNumber - Current attempt number (0-indexed)
 * @returns Promise that resolves when reconnection is scheduled
 */
export async function scheduleReconnect(params: {
  accountId: string;
  config: QqNativeConfig;
  callbacks: QqNativeCallbacks;
  attemptNumber?: number;
}): Promise<void> {
  const { accountId, config, callbacks } = params;
  const attempt = params.attemptNumber ?? 0;

  // Enforce max attempts
  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    callbacks.log.error(`[QQ/native] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${accountId}`);
    callbacks.onDisconnect?.(`Max reconnect attempts reached`);
    reconnectAttempts.delete(accountId);
    return;
  }

  // Calculate delay with jitter
  const baseDelay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  const jitter = Math.random() * 1000; // 0-1 second jitter
  const delay = baseDelay + jitter;

  callbacks.log.info(
    `[QQ/native] Reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} for ${accountId} in ${Math.round(delay)}ms`,
  );

  // Schedule reconnect
  setTimeout(() => {
    void doReconnect({ accountId, config, callbacks, attemptNumber: attempt });
  }, delay);
}

async function doReconnect(params: {
  accountId: string;
  config: QqNativeConfig;
  callbacks: QqNativeCallbacks;
  attemptNumber: number;
}): Promise<void> {
  const { accountId, config, callbacks, attemptNumber } = params;

  try {
    // Clear existing client if any
    clearActiveNativeClient(accountId);

    callbacks.log.info(`[QQ/native] Attempting reconnect ${attemptNumber + 1} for ${accountId}`);

    // Create new client and start
    await startQqNativeClient({
      accountId,
      config,
      callbacks,
      abortSignal: new AbortController().signal,
    });

    // Success - reset attempt counter
    reconnectAttempts.delete(accountId);
    callbacks.log.info(`[QQ/native] Reconnect successful for ${accountId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    callbacks.log.error(
      `[QQ/native] Reconnect attempt ${attemptNumber + 1} failed for ${accountId}: ${error.message}`,
    );

    // Schedule next attempt
    await scheduleReconnect({
      accountId,
      config,
      callbacks,
      attemptNumber: attemptNumber + 1,
    });
  }
}
