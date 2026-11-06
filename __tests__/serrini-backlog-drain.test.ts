import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  automations: vi.fn(), logs: vi.fn(), holds: vi.fn(), suppressions: vi.fn(),
  history: vi.fn(), comments: vi.fn(), replies: vi.fn(), add: vi.fn(), event: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  automation: { findMany: m.automations },
  dmLog: { findMany: m.logs, findFirst: m.holds },
  instagramReplySuppression: { findMany: m.suppressions },
  operationalEvent: { create: m.event }, $queryRaw: vi.fn().mockResolvedValue([]),
} }));
vi.mock("@/lib/meta/serrini-history", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/meta/serrini-history")>(),
  getResourceHistory: m.history,
}));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ add: m.add }) }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn().mockResolvedValue({ provider: "META", accessToken: "test" }),
  getRecentMediaComments: m.comments, getCommentReplies: m.replies,
  getUserMedia: vi.fn(), MetaApiError: class extends Error {},
}));
import { reconcileComments } from "@/lib/polling/comment-reconciler";

const account = { id: "connection", instagramId: "17841480865798985", username: "serrini666", workspaceId: "workspace", provider: "META", accessToken: "test" };
const campaign = { id: "ecc", name: "ECC", workspaceId: "workspace", postId: "post", keywords: ["ECC"], wholeWordMatch: false, matchAnyWord: false, matchAnyPost: false, dmMessage: "approved resource", publicReplyEnabled: true, instagramAccount: account };
const history = { postId: "post", key: "ECC", campaignId: "ecc", messageHash: createHash("sha256").update(campaign.dmMessage).digest("hex"), heldNames: ["already_received"], heldIds: ["old_person"] };
function comment(i: number, name = `person${i}`) {
  return { id: `comment${i}`, text: "ECC", from: { id: `person${i}`, username: name }, timestamp: new Date(Date.now() - (1000 - i) * 1000).toISOString() };
}

describe("Serrini automatic backlog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.automations.mockResolvedValue([campaign]);
    m.history.mockResolvedValue(history);
    m.holds.mockResolvedValue(null);
    m.logs.mockResolvedValue([]);
    m.suppressions.mockResolvedValue([]);
    m.replies.mockResolvedValue([]);
    m.add.mockResolvedValue({});
    m.event.mockResolvedValue({});
  });

  it("moves past the oldest historical hold and stopped users to deliver the later backlog", async () => {
    m.comments.mockResolvedValue([comment(0, "already_received"), comment(1), comment(2)]);
    m.suppressions.mockResolvedValue([{ senderId: "person1" }]);
    await reconcileComments();
    expect(m.add).toHaveBeenCalledTimes(1);
    expect(m.add.mock.calls[0][1]).toMatchObject({ commentId: "comment2", commenterName: "person2" });
    expect(m.event.mock.calls[0][0].data.payload).toMatchObject({ matched: 3, historyHeld: 1, suppressed: 1, enqueued: 1 });
  });

  it("drains the account backlog without an artificial per-message delay", async () => {
    m.automations.mockResolvedValue([campaign, { ...campaign, id: "second" }]);
    m.comments.mockResolvedValue(Array.from({ length: 60 }, (_, i) => comment(i)));
    await reconcileComments();
    expect(m.add).toHaveBeenCalledTimes(60);
    expect(m.add.mock.calls[0][2].delay).toBeUndefined();
    expect(m.add.mock.calls[59][2].delay).toBeUndefined();
    expect(new Set(m.add.mock.calls.map(c => c[1].commentId)).size).toBe(60);
  });

  it("holds the account before queueing on an unresolved send or restriction", async () => {
    m.holds.mockResolvedValue({ id: "unresolved" });
    await reconcileComments();
    expect(m.comments).not.toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
  });

  it("uses the seven-day window and permits a private reply despite an old public-only reply", async () => {
    const old = comment(1);
    old.timestamp = new Date(Date.now() - 5 * 86400000).toISOString();
    m.comments.mockResolvedValue([{ ...old, from: { id: "person1" }, username: "person1", replies: { data: [{ from: { username: "serrini666" } }] } }]);
    await reconcileComments();
    expect(m.comments.mock.calls[0][0].sinceMs).toBeLessThan(Date.now() - 6 * 86400000);
    expect(m.add.mock.calls[0][1]).toMatchObject({ commenterName: "person1" });
  });

  it("does not change batching or owner-reply handling for other accounts", async () => {
    m.automations.mockResolvedValue([{ ...campaign, instagramAccount: { ...account, instagramId: "other", username: "other" } }]);
    m.comments.mockResolvedValue([ { ...comment(0), replies: { data: [{ from: { username: "other" } }] } }, ...Array.from({ length: 40 }, (_, i) => comment(i + 1)) ]);
    await reconcileComments();
    expect(m.history).not.toHaveBeenCalled();
    expect(m.add).toHaveBeenCalledTimes(30);
    expect(m.add.mock.calls[0][2]).toBeUndefined();
  });

  it("does not queue when the approved source changed", async () => {
    m.history.mockResolvedValue({ ...history, messageHash: "stale" });
    await reconcileComments();
    expect(m.add).not.toHaveBeenCalled();
  });
});
