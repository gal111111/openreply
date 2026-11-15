import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), context: vi.fn(), membership: vi.fn(), transaction: vi.fn(),
  findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), lock: vi.fn(),
  receipt: vi.fn(), event: vi.fn(), updateMany: vi.fn(), profile: vi.fn(), subscribe: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.context,
  canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  workspaceMember: { findFirst: mocks.membership },
  $transaction: mocks.transaction,
  instagramAccount: { updateMany: mocks.updateMany },
  operationalEvent: { create: mocks.event },
} }));
vi.mock("@/lib/meta/client", () => ({
  getUserInfo: mocks.profile,
  subscribeInstagramAccountToWebhooks: mocks.subscribe,
}));

import { GET as connect } from "@/app/api/instagram/serrini/connect/route";
import { GET as callback } from "@/app/api/instagram/serrini/callback/route";
import { createOAuthState, decryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import {
  FOUNDR_UNIFIED_TARGET,
  TALENT_UNIFIED_TARGET as TARGET,
  createUnifiedTargetState,
  getUnifiedTarget,
  parseUnifiedTargetState,
  selectUnifiedTargetAccount,
} from "@/lib/meta/unified-targets";
import {
  createUnifiedConnectionReceipt,
  parseUnifiedConnectionHandoff,
} from "@/lib/integrations/unified-connection-handoff";

const BASE = "https://openreply.example";
const TOKEN = "unit-test-private-talent-credential";
const ACCOUNT = { id: TARGET.instagramId, username: TARGET.username };
const fetchMock = vi.fn();
let assignedAccounts: { id: string; username: string }[];
let scopes: string[];

function state() {
  return createOAuthState(createUnifiedTargetState(TARGET.key, TARGET.workspaceId));
}

function callbackRequest(cookieName: string = TARGET.stateCookie, signedState = state()) {
  return new NextRequest(`${BASE}/api/instagram/serrini/callback?code=test-code&state=${encodeURIComponent(signedState)}`, {
    headers: { cookie: `${cookieName}=${signedState}` },
  });
}

function result(response: Response) {
  return new URL(response.headers.get("location")!).searchParams.get("serrini");
}

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    targetKey: TARGET.key,
    contentCenterProfileId: TARGET.contentCenterProfileId,
    workspaceId: TARGET.workspaceId,
    username: TARGET.username,
    appId: TARGET.appId,
    configId: TARGET.configId,
    platform: "instagram",
    openReplyAccountId: TARGET.openReplyAccountId,
    instagramId: TARGET.instagramId,
    clientBusinessId: "2226123804613304",
    loginMode: "UNIFIED",
    expiration: { kind: "never" },
    scopes: [...TARGET.requiredScopes],
    verifiedAt: "2026-11-15T07:00:00.000Z",
    accessToken: TOKEN,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T07:00:00Z"));
  vi.stubEnv("NEXTAUTH_URL", BASE);
  vi.stubEnv("NEXTAUTH_SECRET", "unit-test-signed-state-secret");
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  vi.stubEnv("SERRINI_META_APP_ID", TARGET.appId);
  vi.stubEnv("SERRINI_META_APP_SECRET", "unit-test-meta-secret");
  vi.stubEnv("SERRINI_META_CONFIG_ID", TARGET.configId);
  vi.stubEnv("SERRINI_META_BUSINESS_ID", "2226123804613304");
  vi.stubGlobal("fetch", fetchMock);
  assignedAccounts = [ACCOUNT];
  scopes = [...TARGET.requiredScopes];
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    const bodies: Record<string, unknown> = {
      "/v27.0/oauth/access_token": { access_token: TOKEN, expires_in: 0 },
      "/v27.0/me": { client_business_id: "2226123804613304" },
      "/v27.0/debug_token": { data: {
        is_valid: true, app_id: TARGET.appId, scopes, expires_at: 0,
      } },
      "/v27.0/me/assigned_instagram_accounts": { data: assignedAccounts },
    };
    if (!(url.pathname in bodies)) throw new Error("Unexpected test Graph path");
    return new Response(JSON.stringify(bodies[url.pathname]));
  });
  mocks.auth.mockResolvedValue({ user: { id: "talent-owner-test" } });
  mocks.context.mockResolvedValue({ workspaceId: TARGET.workspaceId, role: "OWNER" });
  mocks.membership.mockResolvedValue({ role: "OWNER" });
  mocks.findUnique.mockResolvedValue({
    id: TARGET.openReplyAccountId, instagramId: TARGET.instagramId,
    workspaceId: TARGET.workspaceId, provider: "META", metaAppId: null, metaConfigId: null,
  });
  mocks.findMany.mockResolvedValue([{ instagramId: TARGET.instagramId, workspaceId: TARGET.workspaceId }]);
  mocks.upsert.mockResolvedValue({ id: TARGET.openReplyAccountId });
  mocks.lock.mockResolvedValue(1);
  mocks.receipt.mockResolvedValue({ id: "talent-receipt-test" });
  mocks.event.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.profile.mockResolvedValue({ ...ACCOUNT, name: "HK AI Talents" });
  mocks.subscribe.mockResolvedValue({ success: true });
  mocks.transaction.mockImplementation(async (run) => run({
    $executeRaw: mocks.lock,
    instagramAccount: { findUnique: mocks.findUnique, findMany: mocks.findMany, upsert: mocks.upsert },
    operationalEvent: { create: mocks.receipt },
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("registered Talent identity", () => {
  it("binds profile9, the original account and its four approved capabilities", () => {
    expect(getUnifiedTarget("talent")).toMatchObject({
      contentCenterProfileId: 9, username: "aieverydayyyyy", instagramId: "17841453286100150",
      workspaceId: "cmutbjo0l00010dl18clrgsap", openReplyAccountId: "cmw0fvqyl00010dptynpxm95p",
      replyOwner: "openreply",
    });
    expect(TARGET.requiredScopes).toHaveLength(4);
    expect(TARGET.requiredScopes).not.toContain("instagram_manage_insights");
    expect(Object.isFrozen(TARGET.requiredScopes)).toBe(true);
  });

  it("round-trips through the original signed OAuth state", () => {
    expect(parseUnifiedTargetState(verifyOAuthState(state())?.workspaceId)).toMatchObject({
      targetKey: "talent", contentCenterProfileId: 9, workspaceId: TARGET.workspaceId,
    });
    expect(() => createUnifiedTargetState("talent", "another-workspace")).toThrow();
  });

  it("rejects cross-target identity and prefix substitution", () => {
    const value = parseUnifiedTargetState(createUnifiedTargetState("talent", TARGET.workspaceId));
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(() => parseUnifiedTargetState(FOUNDR_UNIFIED_TARGET.statePrefix + encoded)).toThrow();
    const swapped = Buffer.from(JSON.stringify({ ...value, contentCenterProfileId: 13 })).toString("base64url");
    expect(() => parseUnifiedTargetState(TARGET.statePrefix + swapped)).toThrow();
  });

  it("selects the existing canonical Talent identity from mixed assets", () => {
    expect(selectUnifiedTargetAccount("talent", [
      { id: "17841400000000013", username: "kingofhkai" }, ACCOUNT,
    ])).toEqual(ACCOUNT);
    expect(() => selectUnifiedTargetAccount("talent", [{ ...ACCOUNT, id: "17841400000000014" }]))
      .toThrow("account binding changed");
  });

  it.each([
    { instagramId: "17841400000000014" },
    { openReplyAccountId: "another-account" },
    { workspaceId: "another-workspace" },
    { targetKey: "foundr" },
  ])("rejects a mismatched handoff %j", (overrides) => {
    expect(() => parseUnifiedConnectionHandoff(handoff(overrides), TARGET.workspaceId)).toThrow();
  });

  it("rejects unapproved Insights and strips the private credential from receipts", () => {
    expect(() => parseUnifiedConnectionHandoff(handoff({
      scopes: [...TARGET.requiredScopes, "instagram_manage_insights"],
    }), TARGET.workspaceId)).toThrow("exceed the approved target");
    const receipt = createUnifiedConnectionReceipt(handoff(), TARGET.workspaceId);
    expect(receipt.contentCenterProfileId).toBe(9);
    expect(receipt).not.toHaveProperty("accessToken");
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });
});

describe("Talent normal connect and callback", () => {
  it("uses the target-specific cookie and retains the original callback", async () => {
    const response = await connect(new NextRequest(`${BASE}/api/instagram/serrini/connect?target=talent`));
    const url = new URL(response.headers.get("location")!);
    expect(url.searchParams.get("client_id")).toBe(TARGET.appId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/instagram/serrini/callback`);
    expect(response.cookies.get(TARGET.stateCookie)?.httpOnly).toBe(true);
    expect(response.cookies.get(FOUNDR_UNIFIED_TARGET.stateCookie)).toBeUndefined();
  });

  it("rejects a different workspace before creating any official authorization", async () => {
    mocks.context.mockResolvedValue({ workspaceId: "another-workspace", role: "OWNER" });
    const response = await connect(new NextRequest(`${BASE}/api/instagram/serrini/connect?target=talent`));
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates only the original Talent account and records a credential-free profile9 receipt", async () => {
    assignedAccounts.push({ id: "17841400000000013", username: "kingofhkai" });
    const response = await callback(callbackRequest());
    expect(result(response)).toBe("connected");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const saved = mocks.upsert.mock.calls[0][0];
    expect(saved.where).toEqual({ instagramId: TARGET.instagramId });
    expect(saved.update.metaLoginMode).toBe("UNIFIED");
    expect(decryptToken(saved.update.accessToken)).toBe(TOKEN);
    const receipt = mocks.receipt.mock.calls[0][0].data;
    expect(receipt.message).toContain("HK AI Talents");
    expect(receipt.payload).toMatchObject({
      targetKey: "talent", contentCenterProfileId: 9, openReplyAccountId: TARGET.openReplyAccountId,
      instagramId: TARGET.instagramId, workspaceId: TARGET.workspaceId,
      scopes: [...TARGET.requiredScopes].sort(), contentCenterHandoff: "pending",
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(response.cookies.get(TARGET.stateCookie)?.maxAge).toBe(0);
  });

  it("rejects a Foundr cookie before token exchange", async () => {
    expect(result(await callback(callbackRequest(FOUNDR_UNIFIED_TARGET.stateCookie)))).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_messages"])(
    "rejects a missing required permission %s before saving", async (missing) => {
      scopes = scopes.filter(scope => scope !== missing);
      expect(result(await callback(callbackRequest()))).toBe("failed");
      expect(mocks.upsert).not.toHaveBeenCalled();
    },
  );

  it("rejects unapproved Insights before account persistence or webhook subscription", async () => {
    scopes.push("instagram_manage_insights");
    expect(result(await callback(callbackRequest()))).toBe("failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("rejects a changed canonical identity before account persistence", async () => {
    assignedAccounts = [{ ...ACCOUNT, id: "17841400000000014" }];
    expect(result(await callback(callbackRequest()))).toBe("failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("retains the original workspace ownership guard", async () => {
    mocks.findMany.mockResolvedValue([{ instagramId: TARGET.instagramId, workspaceId: "another-workspace" }]);
    expect(result(await callback(callbackRequest()))).toBe("failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
