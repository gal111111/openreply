import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));
vi.mock("@/lib/instagram-accounts", () => ({ getWorkspaceInstagramAccount: vi.fn() }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(),
  getConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  getMessageMetadata: vi.fn(),
  MetaApiError: class MetaApiError extends Error { code = 100; },
}));

import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  createInstagramContext, getConversations, getConversationMessages, getMessageMetadata,
} from "@/lib/instagram/provider";
import { GET } from "@/app/api/instagram/conversations/[id]/route";

const account = { id: "account", instagramId: "owner" };
const conversation = {
  id: "conversation",
  participants: { data: [{ id: "owner" }, { id: "recipient" }] },
};
const outgoing = {
  id: "native-outgoing", message: "", from: { id: "owner" },
  to: { data: [{ id: "recipient" }] }, created_time: "2026-11-14T17:11:49+0000",
};
const metadata = {
  id: outgoing.id, fromId: "owner", toIds: ["recipient"], createdTime: outgoing.created_time,
  isUnsupported: null, attachmentsReturned: false, attachmentCount: null, attachments: [],
};

function request(query = "instagramAccountId=account&messageId=native-outgoing") {
  return GET(new NextRequest(`https://openreply.example/api/instagram/conversations/conversation?${query}`), {
    params: Promise.resolve({ id: "conversation" }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCurrentWorkspaceId).mockResolvedValue("workspace");
  vi.mocked(getWorkspaceInstagramAccount).mockResolvedValue(account as Awaited<ReturnType<typeof getWorkspaceInstagramAccount>>);
  vi.mocked(createInstagramContext).mockResolvedValue({ provider: "META", accessToken: "private-token" });
  vi.mocked(getConversations).mockResolvedValue([conversation]);
  vi.mocked(getConversationMessages).mockResolvedValue([outgoing]);
  vi.mocked(getMessageMetadata).mockResolvedValue(metadata);
});

describe("conversation-scoped metadata read", () => {
  it("checks the exact workspace/account, owned conversation and message before reading metadata", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(getWorkspaceInstagramAccount).toHaveBeenCalledWith("workspace", "account");
    expect(getConversations).toHaveBeenCalledWith({
      context: { provider: "META", accessToken: "private-token" }, igUserId: "owner",
    });
    expect(getMessageMetadata).toHaveBeenCalledWith({
      context: { provider: "META", accessToken: "private-token" }, messageId: outgoing.id,
    });
    expect(await response.json()).toEqual({ success: true, data: { messageMetadata: metadata } });
  });

  it("preserves the existing response and API calls when messageId is absent", async () => {
    const response = await request("instagramAccountId=account");
    expect(await response.json()).toEqual({ success: true, data: { messages: [{
      id: outgoing.id, text: "", fromMe: true, fromUsername: null, createdTime: outgoing.created_time,
    }] } });
    expect(getConversations).not.toHaveBeenCalled();
    expect(getMessageMetadata).not.toHaveBeenCalled();
  });

  it("requires the original authenticated workspace", async () => {
    vi.mocked(getCurrentWorkspaceId).mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(getWorkspaceInstagramAccount).not.toHaveBeenCalled();
  });

  it.each(["messageId=native-outgoing", "instagramAccountId=all&messageId=native-outgoing", "instagramAccountId=account&messageId="])(
    "rejects missing or ambiguous identifiers (%s)", async (query) => {
      expect((await request(query)).status).toBe(400);
      expect(createInstagramContext).not.toHaveBeenCalled();
    }
  );

  it("rejects an account outside the current workspace", async () => {
    vi.mocked(getWorkspaceInstagramAccount).mockResolvedValue(null);
    expect((await request()).status).toBe(400);
    expect(getConversations).not.toHaveBeenCalled();
  });

  it.each([
    { conversations: [] },
    { conversations: [{ ...conversation, id: "other-conversation" }] },
    { conversations: [{ ...conversation, detailsUnavailable: true }] },
    { conversations: [{ ...conversation, participants: { data: [{ id: "other" }, { id: "recipient" }] } }] },
    { conversations: [{ ...conversation, participants: undefined }] },
  ])("refuses unverified conversation ownership", async ({ conversations }) => {
    vi.mocked(getConversations).mockResolvedValue(conversations);
    expect((await request()).status).toBe(404);
    expect(getConversationMessages).not.toHaveBeenCalled();
    expect(getMessageMetadata).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [] },
    { messages: [{ ...outgoing, id: "other-message" }] },
    { messages: [{ ...outgoing, from: { id: "outsider" } }] },
    { messages: [{ ...outgoing, to: { data: [{ id: "outsider" }] } }] },
    { messages: [{ ...outgoing, to: undefined }] },
  ])("refuses cross-conversation or unverified message participants", async ({ messages }) => {
    vi.mocked(getConversationMessages).mockResolvedValue(messages);
    expect((await request()).status).toBe(404);
    expect(getMessageMetadata).not.toHaveBeenCalled();
  });

  it.each([
    { ...metadata, id: "other-message" },
    { ...metadata, fromId: "outsider" },
    { ...metadata, toIds: ["outsider"] },
  ])("rejects a mismatched Graph metadata response", async (result) => {
    vi.mocked(getMessageMetadata).mockResolvedValue(result);
    expect((await request()).status).toBe(502);
  });

  it("keeps metadata unavailable for Zernio without changing its normal inbox read", async () => {
    vi.mocked(createInstagramContext).mockResolvedValue({
      provider: "ZERNIO", apiKey: "private-key", accountId: "selected", instagramId: "owner",
    });
    expect((await request()).status).toBe(422);
    expect(getConversationMessages).not.toHaveBeenCalled();
    const response = await request("instagramAccountId=account");
    expect(response.status).toBe(200);
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
  });

  it("returns a generic read error without exposing upstream response or credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getMessageMetadata).mockRejectedValue(new Error("private-token signed URL attachment body"));
    const response = await request();
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toMatch(/private-token|signed URL|attachment body/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|signed URL|attachment body/);
    log.mockRestore();
  });
});
