import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { handleOb11Event } from "./inbound.js";
import { getQqRuntime } from "./runtime.js";

vi.mock("./runtime.js", () => ({
  getQqRuntime: vi.fn(),
}));

const mockGetQqRuntime = vi.mocked(getQqRuntime);

describe("handleOb11Event file receive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts file-only message and forwards file url in inbound context", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    const core = {
      channel: {
        commands: {
          shouldHandleTextCommands: () => false,
        },
        text: {
          hasControlCommand: () => false,
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "default",
            accountId: "default",
            sessionKey: "qq:test",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/qq-session",
          readSessionUpdatedAt: () => Date.now() - 1_000,
          recordInboundSession: async () => undefined,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        },
      },
    } as never;
    mockGetQqRuntime.mockReturnValue(core);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "message",
        message_type: "private",
        user_id: 10001,
        message_id: 20001,
        message: [
          {
            type: "file",
            data: {
              url: "https://example.com/report.pdf",
              name: "report.pdf",
            },
          },
        ],
      },
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        connection: {},
        config: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
          allowFrom: [],
          groupAllowFrom: [],
          requireMention: true,
        },
      } as never,
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
    const payload = finalizeInboundContext.mock.calls[0]?.[0] as
      | { MediaUrls?: string[]; BodyForAgent?: string }
      | undefined;
    expect(payload?.MediaUrls).toEqual(["https://example.com/report.pdf"]);
    expect(payload?.BodyForAgent).toContain("[File: report.pdf]");
  });
});
