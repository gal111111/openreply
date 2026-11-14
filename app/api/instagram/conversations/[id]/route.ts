import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  getConversations,
  getConversationMessages,
  getMessageMetadata,
  MetaApiError,
} from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";

export interface ThreadMessage {
  id: string;
  text: string;
  fromMe: boolean;
  fromUsername: string | null;
  createdTime: string | null;
}

export interface ThreadResponse {
  messages: ThreadMessage[];
}

type RouteProps = { params: Promise<{ id: string }> };

// Message history for a single conversation (20 most recent, chronological).
export async function GET(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id: conversationId } = await params;
  const messageId = request.nextUrl.searchParams.get("messageId");
  const accountId = request.nextUrl.searchParams.get("instagramAccountId");
  if (messageId !== null && (!messageId || !accountId || accountId === "all")) {
    return NextResponse.json(
      { success: false, error: "An exact account and message ID are required." },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    accountId
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    const accessToken = await createInstagramContext(account);
    let participantIds: Set<string> | null = null;
    if (messageId !== null) {
      if (accessToken.provider !== "META") {
        return NextResponse.json(
          { success: false, error: "Message metadata is unavailable for this connection." },
          { status: 422 }
        );
      }
      const conversations = await getConversations({ context: accessToken, igUserId: account.instagramId });
      const conversation = conversations.find((item) => item.id === conversationId);
      participantIds = new Set(conversation?.participants?.data.map((participant) => participant.id) ?? []);
      if (!conversation || conversation.detailsUnavailable ||
          !participantIds.has(account.instagramId) || participantIds.size < 2) {
        return NextResponse.json(
          { success: false, error: "Conversation ownership could not be verified for this account." },
          { status: 404 }
        );
      }
    }
    const raw = await getConversationMessages({
      context: accessToken,
      conversationId: conversationId,
    });

    if (messageId !== null && participantIds) {
      const verifiedParticipants = participantIds;
      const original = raw.find((message) => message.id === messageId);
      const recipientIds = original?.to?.data?.map((participant) => participant.id) ?? [];
      if (!original?.from?.id || !verifiedParticipants.has(original.from.id) || recipientIds.length === 0 ||
          recipientIds.some((id) => !verifiedParticipants.has(id))) {
        return NextResponse.json(
          { success: false, error: "Message participants could not be verified in this conversation." },
          { status: 404 }
        );
      }
      const metadata = await getMessageMetadata({ context: accessToken, messageId: original.id });
      if (metadata.id !== original.id || metadata.fromId !== original.from.id ||
          metadata.toIds.length !== recipientIds.length ||
          recipientIds.some((id) => !metadata.toIds.includes(id)) ||
          metadata.toIds.some((id) => !recipientIds.includes(id))) {
        return NextResponse.json(
          { success: false, error: "Message metadata did not match the original conversation." },
          { status: 502 }
        );
      }
      return NextResponse.json({ success: true, data: { messageMetadata: metadata } });
    }

    // The API returns newest-first; reverse to read top-to-bottom.
    const messages: ThreadMessage[] = raw
      .map((m) => ({
        id: m.id,
        text: m.message ?? "",
        fromMe: m.from?.id === account.instagramId,
        fromUsername: m.from?.username ?? null,
        createdTime: m.created_time ?? null,
      }))
      .reverse();

    const data: ThreadResponse = { messages };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    if (messageId !== null) {
      console.error("[Message Metadata] Read failed", { code: err instanceof MetaApiError ? err.code : null });
      return NextResponse.json({ success: false, error: "Failed to read message metadata." }, { status: 502 });
    }
    console.error("[Conversation Messages] Error:", err);
    const message =
      err instanceof MetaApiError ? err.message : "Failed to load messages";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
