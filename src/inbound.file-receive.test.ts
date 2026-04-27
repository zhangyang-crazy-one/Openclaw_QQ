import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { handleOb11Event } from "./inbound.js";
import { getActiveQqClient } from "./adapter.js";
import { getQqRuntime } from "./runtime.js";
import { getActiveNativeClient } from "./qq-native.js";

vi.mock("./runtime.js", () => ({
  getQqRuntime: vi.fn(),
}));
vi.mock("./adapter.js", () => ({
  getActiveQqClient: vi.fn(),
}));
vi.mock("./qq-native.js", () => ({
  getActiveNativeClient: vi.fn(),
}));

const mockGetQqRuntime = vi.mocked(getQqRuntime);
const mockGetActiveQqClient = vi.mocked(getActiveQqClient);
const mockGetActiveNativeClient = vi.mocked(getActiveNativeClient);

describe("handleOb11Event file receive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveQqClient.mockReturnValue(undefined);
    mockGetActiveNativeClient.mockReturnValue(undefined);
  });

  it("downloads inbound file media and forwards local path in inbound context", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.from("pdf"),
      contentType: "application/pdf",
      fileName: "report.pdf",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/openclaw-media/inbound/report---uuid.pdf",
      contentType: "application/pdf",
      id: "report---uuid.pdf",
      size: 3,
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
        media: {
          fetchRemoteMedia,
          saveMediaBuffer,
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
    expect(payload?.MediaUrls).toEqual(["/tmp/openclaw-media/inbound/report---uuid.pdf"]);
    expect(payload?.BodyForAgent).toContain("[File: report.pdf]");
    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://example.com/report.pdf",
      filePathHint: "report.pdf",
      maxBytes: 5 * 1024 * 1024,
    });
    expect(saveMediaBuffer).toHaveBeenCalled();
  });

  it("falls back to original url when media download fails", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    const fetchRemoteMedia = vi.fn(async () => {
      throw new Error("network blocked");
    });
    const saveMediaBuffer = vi.fn();
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
        media: {
          fetchRemoteMedia,
          saveMediaBuffer,
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
        message_id: 20002,
        message: [{ type: "image", data: { url: "https://example.com/img.png" } }],
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

    const payload = finalizeInboundContext.mock.calls[0]?.[0] as
      | { MediaUrls?: string[]; BodyForAgent?: string }
      | undefined;
    expect(payload?.MediaUrls).toEqual(["https://example.com/img.png"]);
    expect(payload?.BodyForAgent).toContain("Attachment: https://example.com/img.png");
    expect(payload?.BodyForAgent).toContain("[Image: https://example.com/img.png]");
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });

  it("downloads media when inbound message is CQ string format", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.from("img"),
      contentType: "image/png",
      fileName: "img.png",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/openclaw-media/inbound/img---uuid.png",
      contentType: "image/png",
      id: "img---uuid.png",
      size: 3,
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
        media: {
          fetchRemoteMedia,
          saveMediaBuffer,
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
        message_id: 20003,
        message: "[CQ:image,file=https://example.com/img.png]",
      },
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        connection: { messageFormat: "string" },
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

    const payload = finalizeInboundContext.mock.calls[0]?.[0] as
      | { MediaUrls?: string[]; BodyForAgent?: string }
      | undefined;
    expect(payload?.MediaUrls).toEqual(["/tmp/openclaw-media/inbound/img---uuid.png"]);
    expect(payload?.BodyForAgent).toContain("Attachment: /tmp/openclaw-media/inbound/img---uuid.png");
    expect(payload?.BodyForAgent).toContain("[Image: /tmp/openclaw-media/inbound/img---uuid.png]");
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it("prefers OneBot get_image local file when multimedia URL fetch is blocked", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    const fetchRemoteMedia = vi.fn(async () => {
      throw new Error("should not fetch multimedia url directly");
    });
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/openclaw-media/inbound/image-from-onebot.png",
      contentType: "image/png",
      id: "image-from-onebot.png",
      size: 3,
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
        media: {
          fetchRemoteMedia,
          saveMediaBuffer,
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
    const localImagePath = `/tmp/qq-onebot-image-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
    await fs.writeFile(localImagePath, Buffer.from("img"));
    try {
      const sendAction = vi.fn(async () => ({
        status: "ok",
        retcode: 0,
        data: { file: localImagePath },
      }));
      mockGetActiveQqClient.mockReturnValue({
        sendAction,
      } as never);

      const multimediaUrl = "https://multimedia.nt.qq.com.cn/download?appid=1407&spec=0";
      await handleOb11Event({
        event: {
          post_type: "message",
          message_type: "private",
          user_id: 10001,
          message_id: 20004,
          message: [{ type: "image", data: { file: "image-token", url: multimediaUrl } }],
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

      const payload = finalizeInboundContext.mock.calls[0]?.[0] as
        | { MediaUrls?: string[]; BodyForAgent?: string }
        | undefined;
      expect(sendAction).toHaveBeenCalledWith("get_image", { file: "image-token" });
      expect(fetchRemoteMedia).not.toHaveBeenCalled();
      expect(payload?.MediaUrls).toEqual(["/tmp/openclaw-media/inbound/image-from-onebot.png"]);
      expect(payload?.BodyForAgent).toContain("/tmp/openclaw-media/inbound/image-from-onebot.png");
      expect(payload?.BodyForAgent).not.toContain("multimedia.nt.qq.com.cn");
    } finally {
      await fs.unlink(localImagePath).catch(() => undefined);
    }
  });
});

describe("handleOb11Event notice file receive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveQqClient.mockReturnValue(undefined);
    mockGetActiveNativeClient.mockReturnValue(undefined);
  });

  function buildMockCore(finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ({
    ...ctx,
    SessionKey: ctx.SessionKey ?? "qq:test",
  }))) {
    return {
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
  }

  function buildDefaultAccount(overrides: Record<string, unknown> = {}) {
    return {
      accountId: "default",
      enabled: true,
      configured: true,
      connection: {},
      config: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        allowFrom: [],
        groupAllowFrom: ["group:12345"],
        requireMention: true,
        ...overrides,
      },
    } as never;
  }

  it("handles offline_file notice for private chat file", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    mockGetQqRuntime.mockReturnValue(buildMockCore(finalizeInboundContext));

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "notice",
        notice_type: "offline_file",
        user_id: 10001,
        self_id: 99999,
        time: 1700000000,
        file: {
          name: "document.pdf",
          url: "https://example.com/files/document.pdf",
          size: 1024000,
        },
      },
      account: buildDefaultAccount(),
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
    const payload = finalizeInboundContext.mock.calls[0]?.[0] as
      | { MediaUrls?: string[]; BodyForAgent?: string; SenderId?: string }
      | undefined;
    expect(payload?.MediaUrls).toEqual(["https://example.com/files/document.pdf"]);
    expect(payload?.BodyForAgent).toContain("[File received: document.pdf");
    expect(payload?.BodyForAgent).toContain("1000.0KB");
    expect(payload?.SenderId).toBe("10001");
  });

  it("handles group_upload notice for group file", async () => {
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey ?? "qq:test",
    }));
    mockGetQqRuntime.mockReturnValue(buildMockCore(finalizeInboundContext));

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "notice",
        notice_type: "group_upload",
        group_id: 12345,
        user_id: 10001,
        self_id: 99999,
        time: 1700000000,
        file: {
          id: "file_abc123",
          name: "report.xlsx",
          url: "https://example.com/files/report.xlsx",
          size: 5242880,
        },
      },
      account: buildDefaultAccount({
        groupAllowFrom: ["group:12345"],
      }),
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
    const payload = finalizeInboundContext.mock.calls[0]?.[0] as
      | { MediaUrls?: string[]; BodyForAgent?: string; SenderId?: string; ChatType?: string }
      | undefined;
    expect(payload?.MediaUrls).toEqual(["https://example.com/files/report.xlsx"]);
    expect(payload?.BodyForAgent).toContain("[File received: report.xlsx");
    expect(payload?.BodyForAgent).toContain("5.0MB");
    expect(payload?.SenderId).toBe("10001");
    expect(payload?.ChatType).toBe("group");
  });

  it("drops group_upload notice when group is not allowlisted", async () => {
    const finalizeInboundContext = vi.fn();
    mockGetQqRuntime.mockReturnValue(buildMockCore(finalizeInboundContext));

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "notice",
        notice_type: "group_upload",
        group_id: 99999,
        user_id: 10001,
        self_id: 99999,
        time: 1700000000,
        file: {
          name: "report.xlsx",
          url: "https://example.com/files/report.xlsx",
        },
      },
      account: buildDefaultAccount({
        groupAllowFrom: ["group:12345"],
      }),
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).not.toHaveBeenCalled();
  });

  it("drops offline_file notice when dmPolicy is disabled", async () => {
    const finalizeInboundContext = vi.fn();
    mockGetQqRuntime.mockReturnValue(buildMockCore(finalizeInboundContext));

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "notice",
        notice_type: "offline_file",
        user_id: 10001,
        file: {
          name: "document.pdf",
          url: "https://example.com/files/document.pdf",
        },
      },
      account: buildDefaultAccount({ dmPolicy: "disabled" }),
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).not.toHaveBeenCalled();
  });

  it("ignores notice events without file info", async () => {
    const finalizeInboundContext = vi.fn();
    mockGetQqRuntime.mockReturnValue(buildMockCore(finalizeInboundContext));

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "notice",
        notice_type: "offline_file",
        user_id: 10001,
      },
      account: buildDefaultAccount(),
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).not.toHaveBeenCalled();
  });

  it("ignores other notice types (e.g. group_decrease)", async () => {
    const finalizeInboundContext = vi.fn();
    mockGetQqRuntime.mockReturnValue(buildMockCore(finalizeInboundContext));

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await handleOb11Event({
      event: {
        post_type: "notice",
        notice_type: "group_decrease",
        group_id: 12345,
        user_id: 10001,
        operator_id: 99999,
      },
      account: buildDefaultAccount(),
      config: {} as OpenClawConfig,
      runtime,
    });

    expect(finalizeInboundContext).not.toHaveBeenCalled();
  });
});
