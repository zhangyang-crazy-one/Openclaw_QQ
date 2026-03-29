/**
 * QQ channel setup wizard.
 *
 * Provides interactive setup flow for QQ accounts using either:
 * - Native oicq login (QQ number + password or QR code)
 * - OneBot 11 (WS/HTTP connection to external bot service)
 */

import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";
import { listQqAccountIds, resolveQqAccount } from "./config.js";

const CHANNEL = "qq" as const;

function resolveConfigured(params: { cfg: OpenClawConfig }): boolean {
  return listQqAccountIds(params.cfg).some((accountId) => {
    const account = resolveQqAccount({ cfg: params.cfg, accountId });
    return account.configured;
  });
}

function buildStatusLines(params: { cfg: OpenClawConfig; configured: boolean }): string[] {
  if (params.configured) {
    return [
      "QQ is configured and ready.",
      "Supported connection types: native (oicq), websocket (OB11), http (OB11).",
      "Native login: use QQ number + password or QR code (no external bot needed).",
      "OB11 mode: requires external LLBot/napcat/go-cqhttp service.",
    ];
  }
  return [
    "QQ requires configuration before use.",
    "Connection types:",
    "  • native: Login directly with QQ number (recommended, no external bot needed)",
    "  • ws/http: Connect to external OneBot 11 service (LLBot/napcat)",
    "Run: openclaw channels setup qq",
  ];
}

export const qqSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,
  status: {
    configuredLabel: "QQ configured",
    unconfiguredLabel: "QQ not configured",
    configuredHint: "QQ channel is ready",
    unconfiguredHint: "Set up QQ to start chatting",
    configuredScore: 1,
    unconfiguredScore: 8,
    resolveConfigured,
    resolveStatusLines: ({ cfg, configured }) => buildStatusLines({ cfg, configured }),
    resolveSelectionHint: ({ cfg, configured }) => {
      if (configured) return undefined;
      const ids = listQqAccountIds(cfg);
      if (ids.length > 0) {
        return `Configure account ${ids[0] === DEFAULT_ACCOUNT_ID ? "(default)" : ids[0]}`;
      }
      return "Add QQ account";
    },
  },
  credentials: [],
  finalize: async () => {
    // No credentials needed for QQ setup (handled via connection config)
  },
};
