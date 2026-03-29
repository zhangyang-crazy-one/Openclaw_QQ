import WebSocket from "ws";
import type {
  OB11ActionResponse,
  OB11Event,
  QQConnectionConfig,
  QQHttpConnectionConfig,
  QQMessageFormat,
  QQWsConnectionConfig,
} from "./types.js";

type RuntimeLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const RECONNECT_DELAY_MS = 3000;
const ACTION_TIMEOUT_MS = 15000;

type PendingAction = {
  resolve: (value: OB11ActionResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type Ob11Client = {
  sendAction: (action: string, params?: Record<string, unknown>) => Promise<OB11ActionResponse>;
  stop: () => void;
  messageFormat: QQMessageFormat;
  reportSelfMessage: boolean;
  reportOfflineMessage: boolean;
};

const activeClients = new Map<string, Ob11Client>();

export function getActiveQqClient(accountId: string): Ob11Client | undefined {
  return activeClients.get(accountId);
}

export function clearActiveQqClient(accountId: string): void {
  activeClients.delete(accountId);
}

export async function startQqClient(params: {
  accountId: string;
  connection: QQConnectionConfig;
  onEvent: (event: OB11Event) => void;
  log: RuntimeLogger;
  abortSignal: AbortSignal;
}): Promise<Ob11Client> {
  const { accountId, connection, onEvent, log, abortSignal } = params;
  let client: Ob11Client;

  if (connection.type === "ws") {
    const wsClient = new Ob11WsClient({ connection, onEvent, log, abortSignal });
    await wsClient.start();
    client = wsClient;
  } else if (connection.type === "http") {
    const httpClient = new Ob11HttpClient({ connection, onEvent, log, abortSignal });
    await httpClient.start();
    client = httpClient;
  } else {
    const type = (connection as { type?: string }).type ?? "unknown";
    throw new Error(`QQ connection type not supported yet: ${type}`);
  }

  activeClients.set(accountId, client);
  return client;
}

function buildWsUrl(params: {
  host: string;
  port: number;
  path: string;
  secure?: boolean;
  token?: string;
}): string {
  const protocol = params.secure ? "wss" : "ws";
  const base = `${protocol}://${params.host}:${params.port}${params.path}`;
  if (!params.token) return base;
  const url = new URL(base);
  url.searchParams.set("access_token", params.token);
  return url.toString();
}

function buildHttpUrl(params: {
  host: string;
  port: number;
  path: string;
  secure?: boolean;
  token?: string;
}): string {
  const protocol = params.secure ? "https" : "http";
  const base = `${protocol}://${params.host}:${params.port}${params.path}`;
  if (!params.token) return base;
  const url = new URL(base);
  url.searchParams.set("access_token", params.token);
  return url.toString();
}

function createAuthHeaders(token?: string): Record<string, string> | undefined {
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

class Ob11WsClient implements Ob11Client {
  public messageFormat: QQMessageFormat;
  public reportSelfMessage: boolean;
  public reportOfflineMessage: boolean;

  private actionSocket: WebSocket | null = null;
  private eventSocket: WebSocket | null = null;
  private pendingActions = new Map<string, PendingAction>();
  private closed = false;
  private nextEcho = 0;

  constructor(
    private params: {
      connection: QQWsConnectionConfig;
      onEvent: (event: OB11Event) => void;
      log: RuntimeLogger;
      abortSignal: AbortSignal;
    },
  ) {
    this.messageFormat = params.connection.messageFormat ?? "array";
    this.reportSelfMessage = params.connection.reportSelfMessage ?? false;
    this.reportOfflineMessage = params.connection.reportOfflineMessage ?? false;
  }

  async start(): Promise<void> {
    const { abortSignal } = this.params;
    if (abortSignal.aborted) {
      throw new Error("QQ connection aborted before start");
    }

    abortSignal.addEventListener("abort", () => {
      this.stop();
    });

    // Connect both sockets, with proper cleanup on partial failure
    let connectionError: Error | null = null;
    try {
      await Promise.all([
        this.connectActionSocket().catch((err) => {
          connectionError = err instanceof Error ? err : new Error(String(err));
          throw err;
        }),
        this.connectEventSocket().catch((err) => {
          connectionError = err instanceof Error ? err : new Error(String(err));
          throw err;
        }),
      ]);
    } catch {
      // On partial failure, both sockets may be partially initialized
      // stop() will clean up any connected sockets
      const err = connectionError ?? new Error("QQ socket connection failed");
      this.params.log.warn(`QQ socket connection failed: ${err.message}`);
      this.stop();
      throw err;
    }
  }

  async sendAction(action: string, params?: Record<string, unknown>): Promise<OB11ActionResponse> {
    const socket = this.actionSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("QQ action socket not connected");
    }

    const echo = `qq:${Date.now()}:${this.nextEcho++}`;
    const payload = { action, params: params ?? {}, echo };
    const message = JSON.stringify(payload);

    return new Promise<OB11ActionResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`OB11 action timed out: ${action}`));
      }, ACTION_TIMEOUT_MS);

      this.pendingActions.set(echo, { resolve, reject, timeoutId });
      socket.send(message);
    });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("OB11 action cancelled"));
    }
    this.pendingActions.clear();

    this.actionSocket?.close();
    this.eventSocket?.close();
    this.actionSocket = null;
    this.eventSocket = null;
  }

  private connectActionSocket(): Promise<void> {
    const { connection } = this.params;
    const url = buildWsUrl({
      host: connection.host,
      port: connection.port,
      path: "/api",
      secure: connection.secure,
      token: connection.token,
    });
    const headers = createAuthHeaders(connection.token);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      let resolved = false;

      socket.on("open", () => {
        this.actionSocket = socket;
        resolved = true;
        resolve();
      });

      socket.on("message", (raw) => {
        this.handleActionMessage(raw.toString());
      });

      socket.on("close", () => {
        this.actionSocket = null;
        if (this.closed || this.params.abortSignal.aborted) return;
        this.params.log.warn("QQ action socket closed; reconnecting...");
        setTimeout(() => {
          this.connectActionSocket().catch((err) => {
            this.params.log.error(`QQ action socket reconnect failed: ${String(err)}`);
          });
        }, RECONNECT_DELAY_MS);
      });

      socket.on("error", (err) => {
        this.params.log.error(`QQ action socket error: ${String(err)}`);
        if (!resolved) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private connectEventSocket(): Promise<void> {
    const { connection } = this.params;
    const url = buildWsUrl({
      host: connection.host,
      port: connection.port,
      path: "/event",
      secure: connection.secure,
      token: connection.token,
    });
    const headers = createAuthHeaders(connection.token);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      let resolved = false;

      socket.on("open", () => {
        this.eventSocket = socket;
        resolved = true;
        resolve();
      });

      socket.on("message", (raw) => {
        this.handleEventMessage(raw.toString());
      });

      socket.on("close", () => {
        this.eventSocket = null;
        if (this.closed || this.params.abortSignal.aborted) return;
        this.params.log.warn("QQ event socket closed; reconnecting...");
        setTimeout(() => {
          void this.connectEventSocket().catch(() => undefined);
        }, RECONNECT_DELAY_MS);
      });

      socket.on("error", (err) => {
        this.params.log.error(`QQ event socket error: ${String(err)}`);
        if (!resolved) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private handleActionMessage(payload: string): void {
    let message: OB11ActionResponse | null = null;
    try {
      message = JSON.parse(payload) as OB11ActionResponse;
    } catch (err) {
      this.params.log.warn(`QQ action parse failed: ${String(err)}`);
      return;
    }
    const echo = message.echo;
    if (!echo) return;
    const key = String(echo);
    const pending = this.pendingActions.get(key);
    if (!pending) return;
    this.pendingActions.delete(key);
    clearTimeout(pending.timeoutId);
    pending.resolve(message);
  }

  private handleEventMessage(payload: string): void {
    let event: OB11Event | null = null;
    try {
      event = JSON.parse(payload) as OB11Event;
    } catch (err) {
      this.params.log.warn(`QQ event parse failed: ${String(err)}`);
      return;
    }
    try {
      this.params.onEvent(event);
    } catch (err) {
      this.params.log.error(`QQ event dispatch failed: ${String(err)}`);
    }
  }
}

class Ob11HttpClient implements Ob11Client {
  public messageFormat: QQMessageFormat;
  public reportSelfMessage: boolean;
  public reportOfflineMessage: boolean;

  private closed = false;
  private eventLoopPromise: Promise<void> | null = null;

  // 401 circuit breaker
  private authErrorCount = 0;
  private readonly AUTH_ERROR_THRESHOLD = 3;
  private circuitOpen = false;

  // Retry configuration
  private readonly RETRY_DELAYS_MS = [1000, 3000, 10000];
  private readonly MAX_RETRIES = 3;

  constructor(
    private params: {
      connection: QQHttpConnectionConfig;
      onEvent: (event: OB11Event) => void;
      log: RuntimeLogger;
      abortSignal: AbortSignal;
    },
  ) {
    this.messageFormat = params.connection.messageFormat ?? "array";
    this.reportSelfMessage = params.connection.reportSelfMessage ?? false;
    this.reportOfflineMessage = params.connection.reportOfflineMessage ?? false;
  }

  async start(): Promise<void> {
    if (this.params.abortSignal.aborted) {
      throw new Error("QQ connection aborted before start");
    }
    this.eventLoopPromise = this.startEventLoop();
  }

  async sendAction(action: string, params?: Record<string, unknown>): Promise<OB11ActionResponse> {
    // Check circuit breaker
    if (this.circuitOpen) {
      throw new Error("QQ HTTP client circuit breaker open (401 auth failure)");
    }

    return this.sendActionWithRetry(action, params, 0);
  }

  private async sendActionWithRetry(
    action: string,
    params: Record<string, unknown> | undefined,
    attemptNumber: number,
  ): Promise<OB11ActionResponse> {
    const { connection } = this.params;
    const url = buildHttpUrl({
      host: connection.host,
      port: connection.port,
      path: `/${action}`,
      secure: connection.secure,
      token: connection.token,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(createAuthHeaders(connection.token) ?? {}),
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params ?? {}),
        signal: this.params.abortSignal,
      });

      // Handle 401 - increment error count and possibly open circuit
      if (response.status === 401) {
        this.authErrorCount++;
        this.params.log.warn(`[QQ/HTTP] 401 auth error (${this.authErrorCount}/${this.AUTH_ERROR_THRESHOLD}) for ${action}`);

        if (this.authErrorCount >= this.AUTH_ERROR_THRESHOLD) {
          this.circuitOpen = true;
          this.params.log.error(`[QQ/HTTP] Circuit breaker opened due to repeated 401 errors`);
          // Auto-reset after 5 minutes
          setTimeout(() => {
            this.circuitOpen = false;
            this.authErrorCount = 0;
            this.params.log.info(`[QQ/HTTP] Circuit breaker reset`);
          }, 5 * 60 * 1000);
        }

        throw new Error(`OB11 HTTP auth failed (401): ${action}`);
      }

      // Handle other non-ok responses
      if (!response.ok) {
        // Reset auth error count on non-401 errors
        this.authErrorCount = 0;
        throw new Error(`OB11 HTTP action failed (${response.status}): ${action}`);
      }

      // Success - reset auth error count
      this.authErrorCount = 0;
      return (await response.json()) as OB11ActionResponse;
    } catch (err) {
      // Check if retryable
      if (attemptNumber >= this.MAX_RETRIES) {
        throw err;
      }

      // Retry on network errors and 5xx responses
      const isNetworkError =
        err instanceof TypeError ||
        (err instanceof Error && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(err.message));

      if (isNetworkError) {
        const delay = this.RETRY_DELAYS_MS[Math.min(attemptNumber, this.RETRY_DELAYS_MS.length - 1)];
        this.params.log.info(`[QQ/HTTP] Retrying ${action} in ${delay}ms (attempt ${attemptNumber + 1}/${this.MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.sendActionWithRetry(action, params, attemptNumber + 1);
      }

      throw err;
    }
  }

  stop(): void {
    this.closed = true;
  }

  private async startEventLoop(): Promise<void> {
    const { abortSignal } = this.params;
    const connection = this.params.connection;

    while (!this.closed && !abortSignal.aborted) {
      try {
        await this.openEventStream();
      } catch (err) {
        if (abortSignal.aborted || this.closed) return;
        this.params.log.warn(`QQ event stream error: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }

  private async openEventStream(): Promise<void> {
    const { connection } = this.params;
    const url = buildHttpUrl({
      host: connection.host,
      port: connection.port,
      path: "/_events",
      secure: connection.secure,
      token: connection.token,
    });
    const headers = createAuthHeaders(connection.token) ?? {};

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: this.params.abortSignal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`OB11 HTTP events failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    while (!this.closed && !this.params.abortSignal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        } else if (line.trim() === "") {
          if (dataLines.length > 0) {
            this.handleEventPayload(dataLines.join("\n"));
            dataLines = [];
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  }

  private handleEventPayload(payload: string): void {
    if (!payload.trim()) return;
    let event: OB11Event | null = null;
    try {
      event = JSON.parse(payload) as OB11Event;
    } catch (err) {
      this.params.log.warn(`QQ event parse failed: ${String(err)}`);
      return;
    }
    this.params.onEvent(event);
  }
}
