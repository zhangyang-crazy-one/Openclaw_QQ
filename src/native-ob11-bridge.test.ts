import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendQqMessage } from "./native-ob11-bridge.js";

vi.mock("./adapter.js", () => ({
  getActiveQqClient: vi.fn(),
}));

vi.mock("./qq-native.js", () => ({
  getActiveNativeClient: vi.fn(),
}));

vi.mock("./self-sent.js", () => ({
  extractMessageIdFromResponse: vi.fn(),
  rememberSelfSentResponse: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendOb11Message: vi.fn(),
}));

vi.mock("./message-utils.js", () => ({
  safeQqId: vi.fn((value: string | number) => Number(value)),
}));

import { getActiveQqClient } from "./adapter.js";
import { getActiveNativeClient } from "./qq-native.js";
import { extractMessageIdFromResponse, rememberSelfSentResponse } from "./self-sent.js";
import { sendOb11Message } from "./send.js";
import { safeQqId } from "./message-utils.js";

const mockGetActiveNativeClient = vi.mocked(getActiveNativeClient);
const mockGetActiveQqClient = vi.mocked(getActiveQqClient);
const mockSendOb11Message = vi.mocked(sendOb11Message);
const mockRememberSelfSentResponse = vi.mocked(rememberSelfSentResponse);
const mockExtractMessageIdFromResponse = vi.mocked(extractMessageIdFromResponse);
const mockSafeQqId = vi.mocked(safeQqId);

function makeAccount(overrides: Partial<{ accountId: string; enabled: boolean }> = {}) {
  return {
    accountId: overrides.accountId ?? "qq-test",
    enabled: overrides.enabled ?? true,
    configured: true,
    config: {},
  } as Parameters<typeof sendQqMessage>[0]["account"];
}

describe("sendQqMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses native client → calls sendGroupMsg with correct group ID, returns messageId + chatId, remembers self-sent", async () => {
    const nativeClient = {
      sendGroupMsg: vi.fn().mockResolvedValue(888),
      sendPrivateMsg: vi.fn(),
    };
    mockGetActiveNativeClient.mockReturnValue(nativeClient as never);
    mockSafeQqId.mockReturnValue(12345);

    const result = await sendQqMessage({
      account: makeAccount({ accountId: "qq-native" }),
      target: { kind: "group", id: "group-abc" },
      text: "hello group",
    });

    expect(mockSafeQqId).toHaveBeenCalledWith("group-abc");
    expect(nativeClient.sendGroupMsg).toHaveBeenCalledWith(12345, "hello group");
    expect(nativeClient.sendPrivateMsg).not.toHaveBeenCalled();
    expect(mockRememberSelfSentResponse).toHaveBeenCalledWith({
      accountId: "qq-native",
      response: { status: "ok", data: { message_id: 888 } },
      target: "group:group-abc",
      text: "hello group",
    });
    expect(result).toEqual({ messageId: "888", chatId: "group:group-abc" });
  });

  it("uses native client → calls sendPrivateMsg with correct user ID for private target", async () => {
    const nativeClient = {
      sendGroupMsg: vi.fn(),
      sendPrivateMsg: vi.fn().mockResolvedValue(777),
    };
    mockGetActiveNativeClient.mockReturnValue(nativeClient as never);
    mockSafeQqId.mockReturnValue(99999);

    const result = await sendQqMessage({
      account: makeAccount({ accountId: "qq-native" }),
      target: { kind: "private", id: "user-xyz" },
      text: "hello user",
    });

    expect(mockSafeQqId).toHaveBeenCalledWith("user-xyz");
    expect(nativeClient.sendPrivateMsg).toHaveBeenCalledWith(99999, "hello user");
    expect(nativeClient.sendGroupMsg).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: "777", chatId: "user-xyz" });
  });

  it("falls back to OB11 when native client absent, returns resolved messageId + chatId", async () => {
    mockGetActiveNativeClient.mockReturnValue(undefined);
    mockGetActiveQqClient.mockReturnValue({ messageFormat: "array" } as never);
    mockSendOb11Message.mockResolvedValue({
      status: "ok",
      retcode: 0,
      data: { message_id: 4567 },
    });
    mockExtractMessageIdFromResponse.mockReturnValue("4567");

    const result = await sendQqMessage({
      account: makeAccount({ accountId: "qq-ob11" }),
      target: { kind: "private", id: "10001" },
      text: "hello",
      mediaUrl: "https://example.com/img.png",
      replyToId: "99",
    });

    expect(mockSendOb11Message).toHaveBeenCalledWith({
      client: expect.anything(),
      target: { kind: "private", id: "10001" },
      text: "hello",
      replyToId: "99",
      mediaUrl: "https://example.com/img.png",
    });
    expect(mockRememberSelfSentResponse).toHaveBeenCalledWith({
      accountId: "qq-ob11",
      response: expect.any(Object),
      target: "10001",
      text: "hello",
    });
    expect(result).toEqual({ messageId: "4567", chatId: "10001" });
  });

  it("throws when neither native nor OB11 client is available", async () => {
    mockGetActiveNativeClient.mockReturnValue(undefined);
    mockGetActiveQqClient.mockReturnValue(undefined);

    await expect(
      sendQqMessage({
        account: makeAccount({ accountId: "qq-dead" }),
        target: { kind: "private", id: "10001" },
        text: "hello",
      }),
    ).rejects.toThrow("QQ client not running for account qq-dead");
  });
});
