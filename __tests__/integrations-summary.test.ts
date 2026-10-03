import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockUserId } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn(), findMany: vi.fn() },
    workspaceMember: { findMany: vi.fn() },
    dmLog: { count: vi.fn() },
    instagramAccount: { count: vi.fn() },
  },
  mockUserId: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: mockUserId }));

import { GET } from "../app/api/integrations/v1/summary/route";
import { hashServiceKey } from "../lib/integrations/service-key";

const PORTAL_KEY = "hlk_portal_" + "p".repeat(40);
const HUB_KEY = "hlk_hub_" + "h".repeat(40);

function req(headers: Record<string, string> = {}, query = "") {
  return new NextRequest(`http://localhost/api/integrations/v1/summary${query}`, {
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://reply.example.com";
  process.env.HOBBYLAND_SERVICE_KEYS = JSON.stringify({
    portal: { sha256: hashServiceKey(PORTAL_KEY), scopes: ["summary:read"] },
    hub: { sha256: hashServiceKey(HUB_KEY), scopes: ["automations:write"] },
  });
  delete process.env.OPENREPLY_DEFAULT_WORKSPACE;
  mockUserId.mockResolvedValue(null);
  mockPrisma.dmLog.count.mockResolvedValue(2);
  mockPrisma.instagramAccount.count.mockResolvedValue(1);
});

describe("GET /api/integrations/v1/summary", () => {
  it("returns 401 when not signed in and no key is sent", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "需要登入。" });
    expect(mockPrisma.dmLog.count).not.toHaveBeenCalled();
  });

  it("scopes a signed-in user to their workspaces", async () => {
    mockUserId.mockResolvedValue("user_1");
    mockPrisma.workspaceMember.findMany.mockResolvedValue([
      { workspaceId: "ws_1" },
      { workspaceId: "ws_2" },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ system: "openreply", count: 3 });
    expect(json.items).toEqual([
      { title: "最近 24 小時發送失敗的私訊 2 則", count: 2, url: "https://reply.example.com/logs" },
      {
        title: "Instagram 帳號連線失效 1 個，需要重新連線",
        count: 1,
        url: "https://reply.example.com/settings",
      },
    ]);
    const where = mockPrisma.dmLog.count.mock.calls[0][0].where;
    expect(where).toMatchObject({
      workspaceId: { in: ["ws_1", "ws_2"] },
      status: "FAILED",
    });
    expect(Date.now() - where.updatedAt.gte.getTime()).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1000 - 1000
    );
  });

  it("returns zero without querying for a user with no workspaces", async () => {
    mockUserId.mockResolvedValue("user_1");
    mockPrisma.workspaceMember.findMany.mockResolvedValue([]);
    const json = await (await GET(req())).json();
    expect(json).toMatchObject({ count: 0, items: [] });
    expect(mockPrisma.dmLog.count).not.toHaveBeenCalled();
  });

  it("accepts a service key with summary:read", async () => {
    const res = await GET(req({ authorization: `Bearer ${PORTAL_KEY}` }));
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(3);
    expect(mockUserId).not.toHaveBeenCalled();
  });

  it("rejects a service key without summary:read or with a wrong secret", async () => {
    expect((await GET(req({ authorization: `Bearer ${HUB_KEY}` }))).status).toBe(403);
    expect(
      (await GET(req({ authorization: "Bearer hlk_portal_" + "x".repeat(40) }))).status
    ).toBe(401);
  });

  it("limits a service key to the default workspace when set", async () => {
    process.env.OPENREPLY_DEFAULT_WORKSPACE = "ws_9";
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_9", name: "x" });
    await GET(req({ authorization: `Bearer ${PORTAL_KEY}` }));
    expect(mockPrisma.instagramAccount.count.mock.calls[0][0].where).toMatchObject({
      workspaceId: { in: ["ws_9"] },
    });
  });
});
