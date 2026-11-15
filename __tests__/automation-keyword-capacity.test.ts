import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockContext, mockAccount, mockPrisma, mockSyncLinks } = vi.hoisted(() => ({
  mockContext: vi.fn(),
  mockAccount: vi.fn(),
  mockSyncLinks: vi.fn(),
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role),
}));
vi.mock("@/lib/instagram-accounts", () => ({
  getWorkspaceInstagramAccount: mockAccount,
}));
vi.mock("@/lib/campaigns/links", () => ({
  buildInitialCampaignLinks: () => [],
  syncCampaignLinks: mockSyncLinks,
}));

import { PATCH, POST } from "../app/api/automations/route";
import { POST as importCampaigns } from "../app/api/automations/import/route";

const originalKeywords = [
  "登記", "登记", "報名", "报名", "應徵", "应征",
  "想做", "有興趣", "有兴趣", "register",
];
const talentKeywords = [...originalKeywords, "搵工", "揾工"];
const existingCampaign = {
  id: "talent-rule",
  workspaceId: "workspace-1",
  instagramAccountId: "instagram-1",
  keywords: originalKeywords,
  dmMessage: "歡迎加入，請免費填表。 {link}",
  linkButtonLabel: "免費人才登記",
  isActive: true,
  requireFollow: false,
  dmTriggerEnabled: true,
};

function request(method: string, body: unknown) {
  return new NextRequest("https://example.com/api/automations?id=talent-rule", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.mockResolvedValue({ workspaceId: "workspace-1", role: "OWNER" });
  mockAccount.mockResolvedValue({ id: "instagram-1" });
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace-1" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "instagram-1" });
  mockPrisma.automation.findFirst.mockResolvedValue(existingCampaign);
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
    id: "new-rule",
    ...data,
  }));
  mockPrisma.automation.update.mockImplementation(async ({ data }) => ({
    ...existingCampaign,
    ...data,
  }));
  mockPrisma.$transaction.mockImplementation(async (operation) => operation(mockPrisma));
});

describe("campaign keyword capacity through normal routes", () => {
  it.each([{ keywords: originalKeywords }, { keywords: talentKeywords }])(
    "accepts an existing or extended keyword list when creating",
    async ({ keywords }) => {
      const response = await POST(request("POST", {
        name: "人才登記",
        instagramAccountId: "instagram-1",
        matchAnyPost: true,
        keywords,
        dmMessage: existingCampaign.dmMessage,
      }));
      expect(response.status).toBe(201);
      expect(mockPrisma.automation.create.mock.calls[0][0].data.keywords).toEqual(keywords);
    }
  );

  it("updates twelve keywords without changing the existing message or controls", async () => {
    const response = await PATCH(request("PATCH", { keywords: talentKeywords }));
    expect(response.status).toBe(200);
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith({
      where: { id: "talent-rule", workspaceId: "workspace-1" },
    });
    expect(mockPrisma.automation.update.mock.calls[0][0].data).toEqual({
      keywords: talentKeywords,
    });
    expect((await response.json()).data).toEqual({
      ...existingCampaign,
      keywords: talentKeywords,
    });
  });

  it("accepts twelve keywords when importing a campaign", async () => {
    const response = await importCampaigns(request("POST", {
      instagramAccountId: "instagram-1",
      campaigns: [{ postId: "post-1", keywords: talentKeywords, dmMessage: "資料連結" }],
    }));
    expect(response.status).toBe(200);
    expect(mockPrisma.automation.create.mock.calls[0][0].data.keywords).toEqual(talentKeywords);
  });

  const tooManyKeywords = [...talentKeywords, "extra"];
  it.each([
    {
      name: "create",
      run: () => POST(request("POST", {
        name: "Talent", matchAnyPost: true, keywords: tooManyKeywords, dmMessage: "link",
      })),
    },
    {
      name: "update",
      run: () => PATCH(request("PATCH", { keywords: tooManyKeywords })),
    },
    {
      name: "import",
      run: () => importCampaigns(request("POST", {
        instagramAccountId: "instagram-1",
        campaigns: [{ postId: "post-1", keywords: tooManyKeywords, dmMessage: "link" }],
      })),
    },
  ])("rejects thirteen keywords for $name before writing", async ({ run }) => {
    const response = await run();
    expect(response.status).toBe(400);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it.each([
    { context: null, status: 401 },
    { context: { workspaceId: "workspace-1", role: "MEMBER" }, status: 403 },
  ])("keeps the existing role gate for keyword updates ($status)", async ({ context, status }) => {
    mockContext.mockResolvedValue(context);
    const response = await PATCH(request("PATCH", { keywords: talentKeywords }));
    expect(response.status).toBe(status);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });
});
