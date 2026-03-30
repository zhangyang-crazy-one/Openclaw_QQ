import type { DmPolicy, GroupPolicy, MarkdownConfig } from "./sdk-compat.js";

export type QQMessageFormat = "array" | "string";

export type QQNativeConnectionConfig = {
  /** Native QQ protocol via oicq (no external bot service required). */
  type: "native";
  /** QQ account number (uin). */
  uin: number;
  /** Login password. If omitted, QR code login is used. */
  password?: string;
  /** Use QR code login instead of password. Default: true if no password. */
  qrLogin?: boolean;
  /** Device platform. Default: 2 (Android). */
  platform?: number;
  /** Data directory for storing login tokens/session. Defaults to ~/.oicq. */
  dataDir?: string;
  /** Whether to report self-sent messages. Default: false. */
  reportSelfMessage?: boolean;
  /** Whether to report offline messages. Default: false. */
  reportOfflineMessage?: boolean;
};

export type QQWsConnectionConfig = {
  type: "ws";
  host: string;
  port: number;
  secure?: boolean;
  token?: string;
  heartInterval?: number;
  messageFormat?: QQMessageFormat;
  reportSelfMessage?: boolean;
  reportOfflineMessage?: boolean;
};

export type QQHttpConnectionConfig = {
  type: "http";
  host: string;
  port: number;
  secure?: boolean;
  token?: string;
  messageFormat?: QQMessageFormat;
  reportSelfMessage?: boolean;
  reportOfflineMessage?: boolean;
};

export type QQConnectionConfig =
  | QQWsConnectionConfig
  | QQHttpConnectionConfig
  | QQNativeConnectionConfig;

export type QQGroupConfig = {
  requireMention?: boolean;
  agentId?: string;
  enabled?: boolean;
};

export type QQAccountConfig = {
  name?: string;
  enabled?: boolean;
  markdown?: MarkdownConfig;
  connection?: QQConnectionConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  requireMention?: boolean;
  groups?: Record<string, QQGroupConfig>;
};

export type QQConfig = QQAccountConfig & {
  accounts?: Record<string, QQAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedQQAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: QQAccountConfig;
  connection?: QQConnectionConfig;
};

export type OB11MessageSegment = {
  type: string;
  data: Record<string, string | number>;
};

export type OB11MessageSender = {
  user_id?: number;
  nickname?: string;
  card?: string;
};

export type OB11MessageEvent = {
  post_type?: string;
  message_type?: "private" | "group";
  message?: string | OB11MessageSegment[];
  raw_message?: string;
  message_id?: number | string;
  sub_type?: string;
  user_id?: number;
  group_id?: number;
  self_id?: number;
  time?: number;
  sender?: OB11MessageSender;
};

export type OB11Event = OB11MessageEvent & Record<string, unknown>;

export type OB11ActionResponse<T = unknown> = {
  status?: string;
  retcode?: number;
  data?: T;
  msg?: string;
  echo?: string | number;
};
