import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    zernioConnection: { findUnique: vi.fn() },
    postbackDelivery: { create: vi.fn(), delete: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    instagramReplySuppression: { findUnique: vi.fn(), upsert: vi.fn() },
    dmLog: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
  MetaDeliveryUnconfirmedError: class MetaDeliveryUnconfirmedError extends Error {
    name = "MetaDeliveryUnconfirmedError";
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
  };
});

import { createDMWorker } from "../lib/queue/dm-worker";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Two different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT) and the postback's name lookup. Only the
  // latter should resolve by default, or every comment would look like a
  // duplicate of an already-answered one.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { status?: string; followPromptSentAt?: unknown } } = {}) =>
      args.where?.status === "SENT" || args.where?.followPromptSentAt
        ? null // no earlier answer, no recent follow prompt
        : { commenterName: "commenter_user" }
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockResolvedValue({});
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(0);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
});

describe("DM Worker — comments left on an ad", () => {
  it("also matches the organic post the ad was created from", async () => {
    const processor = getProcessor();

    // A boosted post: the comment carries the ad's media id, while the
    // campaign is bound to the post the ad was made from. Without the second
    // id in the query the comment matches nothing and is dropped silently.
    await processor(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { postId: "ad_media_999" },
            { postId: "media_101" },
            { matchAnyPost: true },
          ],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker — Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        dmFallback: false,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            label: true,
            destinationUrl: true,
          },
          // Button order: position first, with createdAt and id only as
          // tie breakers, so tied rows can never come back swapped.
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    // A successful send keeps its slot; the release path is failure-only.
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "comment_555",
        requeueAttempt: 1,
      }),
      expect.objectContaining({
        delay: 1800000,
        jobId: "comment_ig_456_comment_555_retry_1",
      })
    );
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new Error("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should use 'there' when commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey there! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as web_url buttons (one or two)", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
          {
            slug: "def456",
            label: "Book a call",
            destinationUrl: "https://example.com/book",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Primary button title comes from linkButtonLabel; the second from its
    // own stored label. Both point at their tracked /r/<slug> URLs.
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        { title: "Get offer", url: "http://localhost:3000/r/abc123" },
        { title: "Book a call", url: "http://localhost:3000/r/def456" },
      ]
    );
  });

  it("should send a follow-gate prompt when a non-follower comments", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false); // not following yet
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first {username}, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // The follow prompt goes out with a `followcheck:` postback button; the
    // link is NOT delivered yet.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Follow me first commenter_user, then tap 👇",
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should skip the prompt and send the link when the commenter already follows", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true); // already following
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Confirmed follower: no prompt, link delivered right away.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [{ title: "Get offer", url: "http://localhost:3000/r/abc123" }]
    );
  });

  it("should send the opening DM first (routing to the follow check) when both opening DM and follow-gate are on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        openingDmEnabled: true,
        openingDmMessage: "Hey {username}, welcome!",
        openingDmButtonLabel: "Get the link",
        requireFollow: true,
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Opening DM goes out first; its button routes into the follow check.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "comment_555",
      "Hey commenter_user, welcome!",
      "Get the link",
      "followcheck:auto_789"
    );
    // Follow status is verified on the tap, not at comment time.
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
  });

  it("should deliver the next DM from a read fallback when no button tap has sent it yet", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
        },
      },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not deliver a read fallback when the button tap already sent the reveal", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_reveal",
      status: "SENT",
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback bypass the follow gate", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(false); // still not following

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Non-follower on a read fallback: no link, and no re-prompt spam either.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should deliver a follow-gated read fallback once the user follows", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not log a failure when a read fallback hits a closed messaging window", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(
      new Error("This message is sent outside of allowed window.")
    );

    const processor = getProcessor();
    // The window cannot reopen on its own, so this must not throw (no retries)
    // and must not leave a FAILED row the user can do nothing about.
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      )
    ).resolves.toBeUndefined();

    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("should still log a failure for a real button tap that fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(new Error("boom"));

    const processor = getProcessor();
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
        })
      )
    ).rejects.toThrow("boom");

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker — one private reply per comment", () => {
  it("should skip a campaign when another already used the comment's private reply", async () => {
    // Only the cross-campaign lookup (automationId: { not: … }) finds a SENT
    // log; the same-campaign "already answered this person" lookup does not.
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string; automationId?: unknown } } = {}) =>
        args.where?.status === "SENT"
          ? typeof args.where.automationId === "object"
            ? { automation: { name: "openreply 1" } }
            : null
          : { commenterName: "commenter_user" }
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("openreply 1"),
        }),
      })
    );
  });

  it("should not fall back to a plain-text private reply when the window is the problem", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new Error("The comment is invalid for a private reply")
    );

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );

    // The reserved rate slot must be handed back when the send fails, so a
    // comment that never delivered a DM does not burn slots on each retry.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");

    // A text retry on the same comment would fail identically and overwrite the
    // real reason, so it must not be attempted.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: "The comment is invalid for a private reply",
        }),
      })
    );
  });

  it("should still fall back to plain text when the button template itself is rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new Error("Unsupported message template")
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });
});

describe("DM Worker — DM keyword trigger", () => {
  const dmTriggerAutomation = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
  };

  function createMockMessageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
        ...data,
      },
      id: "message_job_001",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerAutomation]);
  });

  it("should reply to a DM whose text matches the campaign keywords", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dmTriggerEnabled: true,
          isActive: true,
        }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // Never a private reply — there is no comment to reply to.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should not reply when the DM text matches no keyword", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "hello there" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("should log the reply against the inbound message id for dedup", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "dm:mid_abc",
          },
        },
        create: expect.objectContaining({
          commenterId: "commenter_999",
          commentText: "can I get the LINK?",
          matchedKeyword: "LINK",
          status: "SENT",
        }),
      })
    );
  });

  it("should not re-send when this message was already answered", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should send the link as buttons when the campaign has tracked links", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Get it",
            destinationUrl: "https://example.com/offer",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should send the follow prompt instead of the link to a non-follower", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      "decrypted_token",
      "ig_456",
      "commenter_999",
      expect.any(String),
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // First contact, so the gate is fail-closed like processComment: an
  // unverifiable status must not hand out the link.
  it("should send the follow prompt when follow status cannot be verified", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should skip and log when the workspace is over its monthly limit", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should release the usage reservation and rethrow when the send fails", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockMessageJob())).rejects.toThrow(
      "Meta is down"
    );

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("Zernio worker routing", () => {
  it("fails open on unknown follow status and sends once through the selected provider", async () => {
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted_key",
    });
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          provider: "ZERNIO",
          workspaceId: "workspace_123",
          zernioAccountId: "zernio_selected",
          accessToken: "",
        },
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            isFollower: null,
            unavailableReason: "consent_required",
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messageId: "sent" }))
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await getProcessor()(createMockJob());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain(
        "/inbox/comments/media_101/comment_555/private-reply"
      );
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).accountId).toBe(
        "zernio_selected"
      );
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SENT" }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("stops BullMQ retries after an ambiguous Zernio direct-message outcome", async () => {
  mockPrisma.zernioConnection.findUnique.mockResolvedValue({
    apiKey: "encrypted",
  });
  mockPrisma.automation.findFirst.mockResolvedValue({
    ...mockAutomation,
    instagramAccount: {
      ...mockAutomation.instagramAccount,
      provider: "ZERNIO",
      workspaceId: "workspace_123",
      zernioAccountId: "remote",
      accessToken: "",
    },
  });
  const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(getProcessor()(createMockPostbackJob())).rejects.toMatchObject(
      {
        name: "UnrecoverableError",
        message: expect.stringContaining("Inspect the Instagram inbox"),
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('binds queued comments to the local connection that received them', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([]);
  const job = createMockJob();
  Object.assign(job.data, { accountConnectionId: 'original-connection' });
  await getProcessor()(job);
  expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instagramAccountId: 'original-connection' }) }));
});

it('never automatically resends a private reply with an unconfirmed delivery', async () => {
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'FAILED', dmDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockSendPrivateReply).not.toHaveBeenCalled();
  expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

it('keeps an unconfirmed public reply untouched after the DM was delivered', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessage: 'Thanks!', publicReplyMessages: [] }]);
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'SENT', publicReplyDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

describe("durable Zernio postback delivery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      },
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      },
    );
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted",
    });
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock = vi.fn();
  });

  function tap(mid: string) {
    return createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid,
    });
  }

  it("retains an uncertain tap across a newer successful tap and queue eviction", async () => {
    fetchMock
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { messageId: "new-tap" } })),
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("old"))).rejects.toMatchObject({
        name: "UnrecoverableError",
      });
      await process(tap("new"));
      await process({ ...tap("old"), id: "redelivery-job" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates successful old taps while permitting each distinct new mid", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await process(tap("first"));
      await process(tap("second"));
      await process({ ...tap("first"), id: "after-retention" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("releases a claim on a confirmed rejection so the same tap can retry", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { messageId: "sent" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("retry"))).rejects.toThrow();
      await process(tap("retry"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("claims concurrent deliveries of the same tap before either can send twice", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await Promise.all([
        process(tap("concurrent")),
        process({ ...tap("concurrent"), id: "other-job" }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates follow-gate prompts as well as reveal messages", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock.mockImplementation(
      async (_url: string, init: { method: string }) =>
        new Response(
          JSON.stringify(
            init.method === "GET"
              ? { isFollower: false }
              : { data: { messageId: "prompt" } },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      const followTap = tap("follow");
      followTap.data = { ...followTap.data, payload: "followcheck:auto_789" };
      await process(followTap);
      await process({ ...followTap, id: "redelivery" });
      expect(
        fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("DM Worker — public reply only after the DM", () => {
  const replyingAutomation = {
    ...mockAutomation,
    publicReplyEnabled: true,
    publicReplyMessages: ["私信你啦 📩"],
  };

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([replyingAutomation]);
  });

  it("posts the public reply after the private reply is sent", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(sendCommentReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendCommentReply).mock.invocationCallOrder[0]).toBeGreaterThan(
      mockSendPrivateReply.mock.invocationCallOrder[0]
    );
  });

  it("does not claim a DM in public when the private reply fails", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    mockSendPrivateReply.mockRejectedValue(new Error("An unknown error has occurred."));
    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("unknown error");
    expect(sendCommentReply).not.toHaveBeenCalled();
  });

  it("still replies when another campaign already sent the comment's DM", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string; automationId?: unknown } } = {}) =>
        args.where?.status === "SENT" && typeof args.where.automationId === "object"
          ? { automation: { name: "other" } }
          : null
    );
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(sendCommentReply).toHaveBeenCalledTimes(1);
  });
});

describe("DM Worker — DM catch-all (menu)", () => {
  const keywordCampaign = {
    ...mockAutomation,
    id: "auto_keyword",
    dmTriggerEnabled: true,
    dmFallback: false,
    requireFollow: false,
    dmMessage: "SKILLS guide",
  };
  const fallbackCampaign = {
    ...mockAutomation,
    id: "auto_menu",
    postId: null,
    matchAnyPost: true,
    matchAnyWord: true,
    keywords: [],
    dmTriggerEnabled: true,
    dmFallback: true,
    requireFollow: false,
    dmMessage: "Menu: reply SKILLS",
  };

  function messageJob(text: string) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_menu",
        messageText: text,
        senderId: "commenter_999",
      },
      id: "message_job_menu",
      attemptsMade: 0,
    };
  }

  function recentFallback(found: boolean) {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { createdAt?: unknown } } = {}) =>
        args.where?.createdAt ? (found ? { id: "log_old" } : null) : { commenterName: "commenter_user" }
    );
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([keywordCampaign, fallbackCampaign]);
    recentFallback(false);
  });

  it("answers with the keyword campaign only when a keyword matches", async () => {
    const processor = getProcessor();
    await processor(messageJob("SKILLS please"));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token", "ig_456", "commenter_999", "SKILLS guide"
    );
  });

  it("sends the menu when no keyword matches", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();
    await processor(messageJob("hi"));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "decrypted_token", "ig_456", "commenter_999", "Menu: reply SKILLS"
    );
  });

  it("sends the menu at most once per sender per 24 hours", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    recentFallback(true);
    const processor = getProcessor();
    await processor(messageJob("thanks!"));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("DM Worker — never twice to the same customer", () => {
  it("does not DM someone a second time for another comment on the same campaign", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string; automationId?: unknown } } = {}) =>
        args.where?.status === "SENT" && typeof args.where.automationId === "string"
          ? { id: "log_earlier_comment" }
          : null
    );
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("earlier comment"),
        }),
      })
    );
  });

  it("skips a comment another job is already handling", async () => {
    const { getRedisConnection } = await import("@/lib/queue/client");
    const set = vi.fn().mockResolvedValue(null); // NX failed: lock held elsewhere
    vi.mocked(getRedisConnection).mockReturnValue({ set, del: vi.fn() } as never);
    const processor = getProcessor();
    await processor(createMockJob());

    expect(set).toHaveBeenCalledWith(
      "openreply:comment-lock:ig_456:comment_555", "1", "EX", 300, "NX"
    );
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    vi.mocked(getRedisConnection).mockReset();
  });

  it("releases the lock after handling the comment", async () => {
    const { getRedisConnection } = await import("@/lib/queue/client");
    const del = vi.fn().mockResolvedValue(1);
    vi.mocked(getRedisConnection).mockReturnValue({ set: vi.fn().mockResolvedValue("OK"), del } as never);
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("openreply:comment-lock:ig_456:comment_555");
    vi.mocked(getRedisConnection).mockReset();
  });

  it("never answers a commenter on the ignore list", async () => {
    process.env.OPENREPLY_IGNORE_COMMENTERS = "@someone, Commenter_User";
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    delete process.env.OPENREPLY_IGNORE_COMMENTERS;
  });

  it("does not answer the same DM keyword twice within the hour", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...mockAutomation, dmTriggerEnabled: true, requireFollow: false },
    ]);
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string; createdAt?: unknown } } = {}) =>
        args.where?.status === "SENT" && args.where.createdAt ? { id: "log_recent" } : null
    );
    const processor = getProcessor();
    await processor({
      name: "process-message",
      data: { instagramAccountId: "ig_456", messageId: "mid_again", messageText: "LINK", senderId: "commenter_999" },
      id: "message_job_again",
      attemptsMade: 0,
    });

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("DM Worker — failed DM retry window", () => {
  it("leaves a comment alone once its DM failed more than two hours ago", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "FAILED",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      publicReplySentAt: null,
    });
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("still retries a DM that failed recently", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "FAILED",
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      publicReplySentAt: null,
    });
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });
});

describe("DM Worker — ignored single comment", () => {
  it("never answers a comment on the ignore list, but answers the same person elsewhere", async () => {
    process.env.OPENREPLY_IGNORE_COMMENT_IDS = "comment_555, other";
    const processor = getProcessor();
    await processor(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();

    await processor(createMockJob({ ...mockJobData, commentId: "comment_777" }));
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    delete process.env.OPENREPLY_IGNORE_COMMENT_IDS;
  });
});

describe("DM Worker — follow first", () => {
  const gated = {
    ...mockAutomation,
    requireFollow: true,
    followPromptMessage: null,
    followPromptButtonLabel: "我已 Follow ✅",
    followPromptMessages: ["先 Follow @skillaihk 🙌", "Follow 咗就撳下面 👇"],
  };

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([gated]);
  });

  it("asks a non-follower to follow with one of the rotating prompts, and marks it as a prompt", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false);
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    const call = mockSendPrivateReplyWithButton.mock.calls[0];
    expect(gated.followPromptMessages).toContain(call[3]);
    expect(call[4]).toBe("我已 Follow ✅");
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT", followPromptSentAt: expect.any(Date) }),
      })
    );
  });

  it("sends the content straight away to a confirmed follower", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true);
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("does not ask the same person to follow twice within 24 hours", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false);
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { followPromptSentAt?: unknown } } = {}) =>
        args.where?.followPromptSentAt ? { id: "log_prompt_earlier" } : null
    );
    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("asked to follow"),
        }),
      })
    );
  });

  it("answers a keyword DM once the person follows, even right after a prompt", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true);
    mockPrisma.automation.findMany.mockResolvedValue([{ ...gated, dmTriggerEnabled: true }]);
    // The only recent SENT log is the follow prompt: excluded from the 1-hour repeat check.
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string; followPromptSentAt?: unknown } } = {}) =>
        args.where?.status === "SENT" && args.where.followPromptSentAt !== null ? { id: "prompt" } : null
    );
    const processor = getProcessor();
    await processor({
      name: "process-message",
      data: { instagramAccountId: "ig_456", messageId: "mid_after_follow", messageText: "LINK", senderId: "commenter_999" },
      id: "message_job_after_follow",
      attemptsMade: 0,
    });

    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });
});


describe("Serrini Unified send reservations", () => {
  function useUnifiedAccount() {
    vi.stubEnv("SERRINI_META_APP_ID", "serrini-app");
    mockPrisma.automation.findMany.mockResolvedValue([{
      ...mockAutomation,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        metaLoginMode: "UNIFIED", metaAppId: "serrini-app",
      },
    }]);
  }

  it("persists an unknown send marker before calling Instagram", async () => {
    useUnifiedAccount();
    mockPrisma.dmLog.updateMany.mockResolvedValue({ count: 1 });
    await getProcessor()(createMockJob());
    const claim = mockPrisma.dmLog.updateMany.mock.calls.find(([args]) => args.data.dmDeliveryUnconfirmed === true);
    expect(claim?.[0].where.dmDeliveryUnconfirmed).toBe(false);
    expect(mockPrisma.dmLog.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mockSendPrivateReply.mock.invocationCallOrder[0]);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({status:"SENT",dmDeliveryUnconfirmed:false}),
    }));
  });

  it("does not send when another process already reserved the inbound", async () => {
    useUnifiedAccount();
    mockPrisma.dmLog.updateMany.mockResolvedValue({ count: 0 });
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("persists an immediate stop request before any resource matching", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({id:"serrini",metaLoginMode:"UNIFIED"});
    await getProcessor()({ ...createMockJob(), name:"process-message", data:{instagramAccountId:"ig",senderId:"sender",messageId:"inbound",messageText:"不要再發 ECC"} });
    expect(mockPrisma.instagramReplySuppression.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create:{instagramAccountId:"serrini",senderId:"sender",inboundId:"inbound"},
    }));
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });
});
