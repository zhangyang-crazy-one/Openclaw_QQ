import { z } from "zod";
import { DmPolicySchema, GroupPolicySchema, MarkdownConfigSchema } from "./sdk-compat.js";

const allowFromEntry = z.union([z.string(), z.number()]);

const groupConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  agentId: z.string().optional(),
  enabled: z.boolean().optional(),
});

const wsConnectionSchema = z.object({
  type: z.literal("ws"),
  host: z.string(),
  port: z.number(),
  secure: z.boolean().optional(),
  token: z.string().optional(),
  heartInterval: z.number().optional(),
  messageFormat: z.enum(["array", "string"]).default("array"),
  reportSelfMessage: z.boolean().optional(),
  reportOfflineMessage: z.boolean().optional(),
});

const httpConnectionSchema = z.object({
  type: z.literal("http"),
  host: z.string(),
  port: z.number(),
  secure: z.boolean().optional(),
  token: z.string().optional(),
  messageFormat: z.enum(["array", "string"]).default("array"),
  reportSelfMessage: z.boolean().optional(),
  reportOfflineMessage: z.boolean().optional(),
});

const nativeConnectionSchema = z.object({
  type: z.literal("native"),
  uin: z.number(),
  password: z.string().optional(),
  qrLogin: z.boolean().optional(),
  platform: z.number().optional(),
  dataDir: z.string().optional(),
  reportSelfMessage: z.boolean().optional(),
  reportOfflineMessage: z.boolean().optional(),
});

const connectionSchema = z.discriminatedUnion("type", [
  wsConnectionSchema,
  httpConnectionSchema,
  nativeConnectionSchema,
]);

const qqAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema.optional(),
  connection: connectionSchema.optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  dmPolicy: DmPolicySchema.optional(),
  groupPolicy: GroupPolicySchema.optional(),
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), groupConfigSchema).optional(),
});

export const QQConfigSchema = qqAccountSchema.extend({
  accounts: z.object({}).catchall(qqAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
