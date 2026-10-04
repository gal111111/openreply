import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown> & { id: string; externalId: string | null };

const { mockPrisma, store, mockResolvePost, mockSyncLinks } = vi.hoisted(() => {
  const store = new Map<string, Row>();
  let seq = 0;
  const mockPrisma = {
    workspace: { findUnique: vi.fn(), findMany: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: {
      findUnique: vi.fn(async ({ where }: { where: { externalId: string } }) => {
        for (const row of store.values()) {
          if (row.externalId === where.externalId) {
            return { ...row, instagramAccount: { username: "skillaihk" }, trackedLinks: [], _count: { dmLogs: 0 } };
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `auto_${++seq}`;
        store.set(id, {
          ...data,
          id,
          externalId: (data.externalId as string) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return { id };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.get(where.id)!;
        store.set(where.id, { ...row, ...data, updatedAt: new Date() });
        return { id: where.id };
      }),
    },
    operationalEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
  };
  return {
    mockPrisma,
    store,
    mockResolvePost: vi.fn(),
    mockSyncLinks: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/integrations/resolve-post", () => ({
  resolveInstagramPostId: mockResolvePost,
}));
vi.mock("@/lib/campaigns/links", async (importActual) => ({
  ...(await importActual<typeof import("../lib/campaigns/links")>()),
  syncCampaignLinks: mockSyncLinks,
}));

import { GET, POST } from "../app/api/integrations/v1/automations/route";
import { hashServiceKey } from "../lib/integrations/service-key";

const WRITE_KEY = "hlk_hub_" + "w".repeat(40);
const READ_ONLY_KEY = "hlk_portal_" + "r".repeat(40);

const payload = {
  external_id: "hub:vp-123:skillaihk",
  workspace: "ws_1",
  instagram_account: "skillaihk",
  post_url: "https://www.instagram.com/reel/ABC123/",
  keywords: ["慳用量"],
  dm_message: "多謝留言，資料在這裡。",
  link_url: "https://example.com/guide",
  active: true,
  source: { system: "hub", production_id: "vp-123" },
};

function post(body: unknown, key = WRITE_KEY) {
  return new NextRequest("http://localhost/api/integrations/v1/automations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  process.env.HOBBYLAND_SERVICE_KEYS = JSON.stringify({
    hub: { sha256: hashServiceKey(WRITE_KEY), scopes: ["automations:write", "automations:read"] },
    portal: { sha256: hashServiceKey(READ_ONLY_KEY), scopes: ["summary:read"] },
  });
  delete process.env.OPENREPLY_DEFAULT_WORKSPACE;
  mockPrisma.workspace.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "ws_1" ? { id: "ws_1", name: "SkillAI HK" } : null
  );
  mockPrisma.workspace.findMany.mockResolvedValue([]);
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "ig_1",
    workspaceId: "ws_1",
    username: "skillaihk",
    provider: "META",
    accessToken: "enc",
    zernioAccountId: null,
    instagramId: "1789",
  });
  mockResolvePost.mockResolvedValue({
    ok: true,
    postId: "media_1",
    postUrl: "https://www.instagram.com/reel/ABC123/",
  });
});

describe("POST /api/integrations/v1/automations", () => {
  it("returns 401 without a key and 403 without the scope", async () => {
    const noKey = new NextRequest("http://localhost/api/integrations/v1/automations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect((await POST(noKey)).status).toBe(401);
    const res = await POST(post(payload, READ_ONLY_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("automations:write");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("returns 401 when service keys are not configured", async () => {
    delete process.env.HOBBYLAND_SERVICE_KEYS;
    expect((await POST(post(payload))).status).toBe(401);
  });

  it("creates a campaign mapped onto the Automation fields", async () => {
    const res = await POST(post(payload));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ external_id: payload.external_id, status: "created" });

    const data = mockPrisma.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      externalId: "hub:vp-123:skillaihk",
      sourceSystem: "hub",
      sourceRef: "vp-123",
      workspaceId: "ws_1",
      instagramAccountId: "ig_1",
      postId: "media_1",
      postUrl: "https://www.instagram.com/reel/ABC123/",
      keywords: ["慳用量"],
      matchAnyWord: false,
      matchAnyPost: false,
      pendingNextReel: false,
      dmMessage: "多謝留言，資料在這裡。",
      isActive: true,
      name: "hub：vp-123",
    });
    const links = data.trackedLinks as { create: unknown[] };
    expect(links.create[0]).toMatchObject({
      destinationUrl: "https://example.com/guide",
      position: 0,
    });
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a resend updates the same campaign", async () => {
    const first = await (await POST(post(payload))).json();
    const res = await POST(
      post({ ...payload, keywords: ["新關鍵字"], active: false })
    );
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second).toMatchObject({ id: first.id, status: "updated" });
    expect(store.size).toBe(1);
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(1);
    expect(store.get(first.id)).toMatchObject({
      keywords: ["新關鍵字"],
      isActive: false,
    });
    // Same post: the stored media id is reused without another Instagram call.
    expect(mockResolvePost).toHaveBeenCalledTimes(1);
    expect(mockSyncLinks).toHaveBeenCalledWith(mockPrisma, {
      workspaceId: "ws_1",
      automationId: first.id,
      primaryUrl: "https://example.com/guide",
    });
  });

  it("falls back to OPENREPLY_DEFAULT_WORKSPACE", async () => {
    process.env.OPENREPLY_DEFAULT_WORKSPACE = "ws_1";
    const { workspace: _omit, ...rest } = payload;
    void _omit;
    expect((await POST(post(rest))).status).toBe(201);
  });

  it("returns 422 when no workspace is given and no default is set", async () => {
    const { workspace: _omit, ...rest } = payload;
    void _omit;
    const res = await POST(post(rest));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("OPENREPLY_DEFAULT_WORKSPACE");
  });

  it("returns 404 for an unknown workspace or Instagram account", async () => {
    expect((await POST(post({ ...payload, workspace: "nope" }))).status).toBe(404);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    const res = await POST(post(payload));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Instagram");
  });

  it("returns 422 when the post is not among the account's media", async () => {
    mockResolvePost.mockResolvedValue({ ok: false, reason: "not_found" });
    expect((await POST(post(payload))).status).toBe(422);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body", async () => {
    const res = await POST(post({ ...payload, keywords: [] }));
    expect(res.status).toBe(400);
  });

  it("creates an every-comment campaign with public replies", async () => {
    const { keywords: _omit, ...rest } = payload;
    void _omit;
    const res = await POST(
      post({
        ...rest,
        external_id: "ig:DeDQ8:comment",
        match_any_comment: true,
        public_replies: ["私信你啦 📩", "私信你啦 🙌"],
      })
    );
    expect(res.status).toBe(201);
    const data = mockPrisma.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      matchAnyWord: true,
      keywords: [],
      dmTriggerEnabled: false,
      publicReplyEnabled: true,
      publicReplyMessages: ["私信你啦 📩", "私信你啦 🙌"],
      publicReplyMessage: "私信你啦 📩",
      name: "hub：vp-123",
    });
  });

  it("creates a DM-keyword campaign with partial matching", async () => {
    const res = await POST(
      post({
        ...payload,
        external_id: "ig:DeDQ8:dm",
        keywords: ["主頁"],
        dm_trigger: true,
        whole_word: false,
      })
    );
    expect(res.status).toBe(201);
    const data = mockPrisma.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      matchAnyWord: false,
      keywords: ["主頁"],
      dmTriggerEnabled: true,
      wholeWordMatch: false,
      publicReplyEnabled: false,
    });
  });

  it("never creates a campaign that would answer every DM", async () => {
    const { keywords: _omit, ...rest } = payload;
    void _omit;
    // A DM trigger without keywords.
    expect((await POST(post({ ...rest, dm_trigger: true }))).status).toBe(400);
    // Any-comment plus DM trigger: the any-word campaign stores no keywords.
    expect(
      (await POST(post({ ...payload, match_any_comment: true, dm_trigger: true }))).status
    ).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("creates a DM catch-all without a post", async () => {
    const res = await POST(
      post({
        external_id: "igpub:menu",
        workspace: "ws_1",
        instagram_account: "skillaihk",
        dm_fallback: true,
        dm_message: "想攞邊份資料？回覆關鍵字：SKILLS／主頁",
      })
    );
    expect(res.status).toBe(201);
    expect(mockResolvePost).not.toHaveBeenCalled();
    const data = mockPrisma.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      dmFallback: true,
      dmTriggerEnabled: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: [],
      postId: null,
      publicReplyEnabled: false,
      name: "hub：私信選單",
    });
  });

  it("rejects a catch-all mixed with other triggers, and a post campaign without post_url", async () => {
    const base = { external_id: "x", workspace: "ws_1", instagram_account: "skillaihk", dm_message: "m" };
    expect((await POST(post({ ...base, dm_fallback: true, keywords: ["A"] }))).status).toBe(400);
    expect((await POST(post({ ...base, dm_fallback: true, match_any_comment: true }))).status).toBe(400);
    expect((await POST(post({ ...base, dm_fallback: true, public_replies: ["hi"] }))).status).toBe(400);
    expect((await POST(post({ ...base, keywords: ["A"] }))).status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("an update keeps dashboard public replies unless the caller sends them", async () => {
    const body = {
      ...payload,
      external_id: "ig:DeDQ8:comment",
      keywords: [],
      match_any_comment: true,
      public_replies: ["私信你啦 📩"],
    };
    const first = await (await POST(post(body))).json();
    // Someone edits the replies in the dashboard.
    store.set(first.id, { ...store.get(first.id)!, publicReplyMessages: ["改過的回覆"] });

    const { public_replies: _omit, ...withoutReplies } = body;
    void _omit;
    expect((await POST(post({ ...withoutReplies, dm_message: "新內容" }))).status).toBe(200);
    expect(store.get(first.id)).toMatchObject({
      publicReplyMessages: ["改過的回覆"],
      dmMessage: "新內容",
      matchAnyWord: true,
    });

    expect((await POST(post({ ...body, public_replies: [] }))).status).toBe(200);
    expect(store.get(first.id)).toMatchObject({
      publicReplyEnabled: false,
      publicReplyMessages: [],
    });
  });
});

describe("GET /api/integrations/v1/automations", () => {
  function get(query: string, key = WRITE_KEY) {
    return new NextRequest(`http://localhost/api/integrations/v1/automations${query}`, {
      headers: { authorization: `Bearer ${key}` },
    });
  }

  it("requires automations:read", async () => {
    expect((await GET(get("?external_id=x", READ_ONLY_KEY))).status).toBe(403);
  });

  it("returns 404 for an unknown external_id and the campaign once created", async () => {
    expect((await GET(get("?external_id=hub:none"))).status).toBe(404);
    await POST(post(payload));
    const res = await GET(get(`?external_id=${encodeURIComponent(payload.external_id)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      external_id: payload.external_id,
      active: true,
      post_id: "media_1",
      keywords: ["慳用量"],
    });
  });
});
