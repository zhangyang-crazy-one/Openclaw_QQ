import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { qqMessageActions } from "./actions.js";
import {
  addReaction,
  deleteQqMessage,
  kickUser,
  muteUser,
  removeReaction,
  setGroupName,
  setGroupWholeBan,
} from "./outbound.js";
import { listEnabledQqAccounts } from "./config.js";

vi.mock("./config.js", () => ({
  listEnabledQqAccounts: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  muteUser: vi.fn(),
  kickUser: vi.fn(),
  deleteQqMessage: vi.fn(),
  setGroupName: vi.fn(),
  setGroupWholeBan: vi.fn(),
}));

const mockListEnabledQqAccounts = vi.mocked(listEnabledQqAccounts);
const mockAddReaction = vi.mocked(addReaction);
const mockRemoveReaction = vi.mocked(removeReaction);
const mockMuteUser = vi.mocked(muteUser);
const mockKickUser = vi.mocked(kickUser);
const mockDeleteQqMessage = vi.mocked(deleteQqMessage);
const mockSetGroupName = vi.mocked(setGroupName);
const mockSetGroupWholeBan = vi.mocked(setGroupWholeBan);

describe("qqMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty actions when no configured enabled accounts", () => {
    mockListEnabledQqAccounts.mockReturnValue([]);
    expect(qqMessageActions.describeMessageTool?.({ cfg: {} as OpenClawConfig })).toEqual({
      actions: [],
      capabilities: [],
      schema: null,
    });
  });

  it("lists supported QQ actions when at least one account is configured", () => {
    mockListEnabledQqAccounts.mockReturnValue([
      { accountId: "default", enabled: true, configured: true } as never,
    ]);
    expect(qqMessageActions.describeMessageTool?.({ cfg: {} as OpenClawConfig })).toEqual({
      actions: [
        "send",
        "react",
        "delete",
        "timeout",
        "kick",
        "ban",
        "renameGroup",
        "permissions",
      ],
      capabilities: [],
      schema: null,
    });
  });

  it("dispatches react action to addReaction by default", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "react",
      cfg,
      params: {
        messageId: "1001",
        emoji: "128512",
      },
      accountId: "qq-main",
    });
    expect(mockAddReaction).toHaveBeenCalledWith({
      cfg,
      accountId: "qq-main",
      messageId: "1001",
      emojiId: "128512",
    });
    expect(result?.details).toEqual({ ok: true, added: "128512" });
  });

  it("dispatches react remove action to removeReaction", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "react",
      cfg,
      params: {
        messageId: "1002",
        emoji: "128542",
        remove: true,
      },
      accountId: "qq-main",
    });
    expect(mockRemoveReaction).toHaveBeenCalledWith({
      cfg,
      accountId: "qq-main",
      messageId: "1002",
      emojiId: "128542",
    });
    expect(result?.details).toEqual({ ok: true, removed: "128542" });
  });

  it("dispatches timeout action to muteUser", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "timeout",
      cfg,
      params: {
        groupId: "3001",
        userId: "4001",
        durationSeconds: 90,
      },
      accountId: "qq-main",
    });
    expect(mockMuteUser).toHaveBeenCalledWith({
      cfg,
      accountId: "qq-main",
      groupId: "3001",
      userId: "4001",
      duration: 90,
    });
    expect(result?.details).toEqual({ ok: true, action: "timeout", duration: 90 });
  });

  it("dispatches kick and ban with the correct rejectAdd flag", async () => {
    const cfg = {} as OpenClawConfig;
    await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "kick",
      cfg,
      params: {
        groupId: "3002",
        userId: "4002",
      },
      accountId: "qq-main",
    });
    await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "ban",
      cfg,
      params: {
        groupId: "3002",
        userId: "4002",
      },
      accountId: "qq-main",
    });
    expect(mockKickUser).toHaveBeenNthCalledWith(1, {
      cfg,
      accountId: "qq-main",
      groupId: "3002",
      userId: "4002",
      rejectAdd: false,
    });
    expect(mockKickUser).toHaveBeenNthCalledWith(2, {
      cfg,
      accountId: "qq-main",
      groupId: "3002",
      userId: "4002",
      rejectAdd: true,
    });
  });

  it("dispatches delete action", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "delete",
      cfg,
      params: {
        messageId: "9001",
      },
      accountId: "qq-main",
    });
    expect(mockDeleteQqMessage).toHaveBeenCalledWith({
      cfg,
      accountId: "qq-main",
      messageId: "9001",
    });
    expect(result?.details).toEqual({ ok: true, action: "delete", messageId: "9001" });
  });

  it("dispatches renameGroup action", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "renameGroup",
      cfg,
      params: {
        groupId: "3100",
        name: "new-group-name",
      },
      accountId: "qq-main",
    });
    expect(mockSetGroupName).toHaveBeenCalledWith({
      cfg,
      accountId: "qq-main",
      groupId: "3100",
      name: "new-group-name",
    });
    expect(result?.details).toEqual({
      ok: true,
      action: "renameGroup",
      groupId: "3100",
      name: "new-group-name",
    });
  });

  it("returns inspect mode for permissions action by default", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "permissions",
      cfg,
      params: {
        groupId: "3200",
      },
      accountId: "qq-main",
    });
    expect(mockSetGroupWholeBan).not.toHaveBeenCalled();
    expect(result?.details).toEqual({
      ok: true,
      action: "permissions",
      groupId: "3200",
      mode: "inspect",
      writable: true,
      supportedUpdates: ["wholeBan"],
      hint: "Set apply=true and enable=true|false to update QQ whole-group mute.",
    });
  });

  it("dispatches permissions update when apply=true", async () => {
    const cfg = {} as OpenClawConfig;
    const result = await qqMessageActions.handleAction?.({
      channel: "qq",
      action: "permissions",
      cfg,
      params: {
        groupId: "3200",
        apply: true,
        enable: false,
      },
      accountId: "qq-main",
    });
    expect(mockSetGroupWholeBan).toHaveBeenCalledWith({
      cfg,
      accountId: "qq-main",
      groupId: "3200",
      enable: false,
    });
    expect(result?.details).toEqual({
      ok: true,
      action: "permissions",
      groupId: "3200",
      mode: "update",
      enable: false,
    });
  });
});
