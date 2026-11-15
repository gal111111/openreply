import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  context: vi.fn(),
  membership: vi.fn(),
  transaction: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  lock: vi.fn(),
  event: vi.fn(),
  receipt: vi.fn(),
  updateMany: vi.fn(),
  profile: vi.fn(),
  subscribe: vi.fn(),
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
  exchangeSerriniCode,
  getSerriniAssets,
  SERRINI_ACCOUNTS,
  SERRINI_SCOPES,
  SERRINI_STATE_COOKIE,
  SERRINI_STATE_PREFIX,
} from "@/lib/meta/serrini-unified";
import {
  createUnifiedTargetState,
  FOUNDR_UNIFIED_TARGET as TARGET,
  parseUnifiedTargetState,
} from "@/lib/meta/unified-targets";

const BASE = "https://openreply.example";
const WORKSPACE = "workspace-foundr-test";
const TOKEN = "unit-test-private-foundr-credential";
const ACCOUNT = { id: "17841400000000013", username: "kingofhkai" };
const fetchMock = vi.fn();
let assignedAccounts: { id: string; username: string }[];
let tokenExpiry: number;
let tokenScopes: string[];
let tokenAppId: string;
let businessId: string;

function connectRequest(query = "?target=foundr") {
  return new NextRequest(`${BASE}/api/instagram/serrini/connect${query}`);
}

function foundrState(workspaceId = WORKSPACE) {
  return createOAuthState(createUnifiedTargetState("foundr", workspaceId));
}

function callbackRequest({
  state = foundrState(),
  cookieName = TARGET.stateCookie,
  cookieValue = state,
  query = "code=unit-test-code",
}: { state?: string; cookieName?: string; cookieValue?: string; query?: string } = {}) {
  return new NextRequest(`${BASE}/api/instagram/serrini/callback?${query}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${cookieName}=${cookieValue}` },
  });
}

function result(response: Response) {
  return new URL(response.headers.get("location")!).searchParams.get("serrini");
}

function assignedPages(pages: unknown[]) {
  const original = fetchMock.getMockImplementation()!;
  let pageIndex = 0;
  fetchMock.mockImplementation(async (input: string) => {
    if (new URL(input).pathname === "/v27.0/me/assigned_instagram_accounts") {
      return new Response(JSON.stringify(pages[pageIndex++]));
    }
    return original(input);
  });
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
  tokenExpiry = 0;
  tokenScopes = [...TARGET.requiredScopes];
  tokenAppId = TARGET.appId;
  businessId = "2226123804613304";
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input);
    const bodies: Record<string, unknown> = {
      "/v27.0/oauth/access_token": { access_token: TOKEN, expires_in: 0 },
      "/v27.0/me": { client_business_id: businessId },
      "/v27.0/debug_token": { data: {
        is_valid: true, app_id: tokenAppId, scopes: tokenScopes, expires_at: tokenExpiry,
      } },
      "/v27.0/me/assigned_instagram_accounts": { data: assignedAccounts },
    };
    if (!(url.pathname in bodies)) throw new Error("Unexpected test Graph path");
    return new Response(JSON.stringify(bodies[url.pathname]));
  });
  mocks.auth.mockResolvedValue({ user: { id: "foundr-owner-test" } });
  mocks.context.mockResolvedValue({ workspaceId: WORKSPACE, role: "OWNER" });
  mocks.membership.mockResolvedValue({ role: "OWNER" });
  mocks.findUnique.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([]);
  mocks.upsert.mockResolvedValue({ id: "foundr-openreply-test" });
  mocks.lock.mockResolvedValue(1);
  mocks.receipt.mockResolvedValue({ id: "foundr-receipt-test" });
  mocks.event.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.profile.mockResolvedValue({ ...ACCOUNT, name: "HKFoundr" });
  mocks.subscribe.mockResolvedValue({ success: true });
  mocks.transaction.mockImplementation(async (run) => run({
    $executeRaw: mocks.lock,
    instagramAccount: {
      findUnique: mocks.findUnique, findMany: mocks.findMany, upsert: mocks.upsert,
    },
    operationalEvent: { create: mocks.receipt },
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("normal Unified connect entry point", () => {
  it("signs the registered target and uses its own HttpOnly cookie", async () => {
    const response = await connect(connectRequest());
    const url = new URL(response.headers.get("location")!);
    const state = url.searchParams.get("state")!;
    expect(parseUnifiedTargetState(verifyOAuthState(state)?.workspaceId)).toMatchObject({
      targetKey: "foundr", workspaceId: WORKSPACE, contentCenterProfileId: 13,
    });
    expect(url.searchParams.get("client_id")).toBe(TARGET.appId);
    expect(url.searchParams.get("config_id")).toBe(TARGET.configId);
    const cookie = response.cookies.get(TARGET.stateCookie);
    expect(cookie).toMatchObject({ value: state, httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
    expect(response.cookies.get(SERRINI_STATE_COOKIE)).toBeUndefined();
  });

  it("preserves the default Serrini state and cookie", async () => {
    const response = await connect(connectRequest(""));
    const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
    expect(verifyOAuthState(state)?.workspaceId).toBe(SERRINI_STATE_PREFIX + WORKSPACE);
    expect(response.cookies.get(SERRINI_STATE_COOKIE)?.value).toBe(state);
    expect(response.cookies.get(TARGET.stateCookie)).toBeUndefined();
  });

  it.each(["13", "kingofhkai", ""])("rejects an unregistered target %s", async (target) => {
    expect((await connect(connectRequest(`?target=${target}`))).status).toBe(400);
  });

  it("rejects mismatched server application configuration before redirect", async () => {
    vi.stubEnv("SERRINI_META_APP_ID", "other-app");
    expect((await connect(connectRequest())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a workspace manager", async () => {
    mocks.context.mockResolvedValue({ workspaceId: WORKSPACE, role: "MEMBER" });
    expect((await connect(connectRequest())).status).toBe(403);
  });
});

describe("Foundr verified Graph assets", () => {
  it("accepts an explicit zero lifetime from exchange and token debug", async () => {
    expect((await exchangeSerriniCode("code", `${BASE}/callback`, "foundr")).expires_in).toBe(0);
    expect(await getSerriniAssets(TOKEN, "foundr")).toMatchObject({
      accounts: [ACCOUNT], expiresAt: null, verificationMethod: "assigned_accounts",
    });
  });

  it("uses the configured real finite lifetime", async () => {
    tokenExpiry = Date.now() / 1000 + 90 * 86400;
    expect((await getSerriniAssets(TOKEN, "foundr")).expiresAt?.getTime()).toBe(tokenExpiry * 1000);
  });

  it("verifies the complete assigned account enumeration across pages", async () => {
    assignedPages([
      { data: [...SERRINI_ACCOUNTS], paging: { next: "next-page", cursors: { after: "second-page" } } },
      { data: [ACCOUNT] },
    ]);
    expect((await getSerriniAssets(TOKEN, "foundr")).accounts).toEqual([ACCOUNT]);
    expect(new URL(fetchMock.mock.calls[3][0]).searchParams.get("after")).toBe("second-page");
  });

  it.each([
    { reason: "missing cursor", pages: [{ data: [ACCOUNT], paging: { next: "next-page" } }] },
    { reason: "repeated cursor", pages: [
      { data: [ACCOUNT], paging: { next: "next-page", cursors: { after: "same-page" } } },
      { data: [], paging: { next: "next-page", cursors: { after: "same-page" } } },
    ] },
  ])("rejects an incomplete enumeration with $reason", async ({ pages }) => {
    assignedPages(pages);
    await expect(getSerriniAssets(TOKEN, "foundr")).rejects.toMatchObject({
      step: "assigned_accounts", reason: "incomplete_pagination",
    });
  });

  it.each([
    { accounts: [] },
    { accounts: [...SERRINI_ACCOUNTS] },
    { accounts: [ACCOUNT, { ...ACCOUNT, id: "17841400000000014" }] },
  ])("requires a unique assigned Foundr identity for %j", async ({ accounts }) => {
    assignedAccounts = accounts;
    await expect(getSerriniAssets(TOKEN, "foundr")).rejects.toThrow();
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  it.each(["scope", "application", "business", "expiry"])("rejects invalid %s provenance", async (field) => {
    if (field === "scope") tokenScopes = ["instagram_basic"];
    if (field === "application") tokenAppId = "999";
    if (field === "business") businessId = "999";
    if (field === "expiry") tokenExpiry = Date.now() / 1000 - 1;
    await expect(getSerriniAssets(TOKEN, "foundr")).rejects.toThrow();
  });

  it("preserves legacy default zero-expiry rejection", async () => {
    await expect(getSerriniAssets(TOKEN)).rejects.toThrow();
  });
});

describe("Foundr callback authentication and persistence", () => {
  it("persists one encrypted account and a token-free receipt atomically", async () => {
    assignedAccounts = [...SERRINI_ACCOUNTS, ACCOUNT];
    const response = await callback(callbackRequest());
    expect(result(response)).toBe("connected");
    expect(mocks.profile).toHaveBeenCalledExactlyOnceWith({
      accessToken: TOKEN, instagramId: ACCOUNT.id, loginMode: "UNIFIED",
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const { create, update } = mocks.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ workspaceId: WORKSPACE, instagramId: ACCOUNT.id, provider: "META" });
    expect(update).toMatchObject({
      username: ACCOUNT.username, metaLoginMode: "UNIFIED", metaAppId: TARGET.appId,
      metaConfigId: TARGET.configId, metaBusinessId: businessId, tokenExpiresAt: null,
    });
    expect(update.accessToken).not.toBe(TOKEN);
    expect(decryptToken(update.accessToken)).toBe(TOKEN);
    const receipt = mocks.receipt.mock.calls[0][0].data.payload;
    expect(receipt).toMatchObject({
      contentCenterProfileId: 13, openReplyAccountId: "foundr-openreply-test",
      instagramId: ACCOUNT.id, expiration: { kind: "never" }, contentCenterHandoff: "pending",
    });
    expect(receipt.connectionVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(response.cookies.get(TARGET.stateCookie)?.maxAge).toBe(0);
    expect(response.cookies.get(SERRINI_STATE_COOKIE)).toBeUndefined();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
  });

  it.each(["id", "username"])("rejects a canonical profile %s mismatch before writes", async (field) => {
    mocks.profile.mockResolvedValue({ ...ACCOUNT, [field]: "different" });
    expect(result(await callback(callbackRequest()))).toBe("failed");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { instagramId: "17841400000000014", workspaceId: WORKSPACE },
    { instagramId: ACCOUNT.id, workspaceId: "another-workspace" },
  ])("rejects a changed prior binding %j", async (previous) => {
    mocks.findMany.mockResolvedValue([previous]);
    expect(result(await callback(callbackRequest()))).toBe("failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { workspaceId: "another-workspace", provider: "META", metaAppId: TARGET.appId },
    { workspaceId: WORKSPACE, provider: "ZERNIO", metaAppId: TARGET.appId },
    { workspaceId: WORKSPACE, provider: "META", metaAppId: "another-app" },
    { workspaceId: WORKSPACE, provider: "META", metaAppId: TARGET.appId, metaConfigId: "another-config" },
  ])("preserves existing owner and provider binding %j", async (existing) => {
    mocks.findUnique.mockResolvedValue(existing);
    expect(result(await callback(callbackRequest()))).toBe("failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("checks membership in the signed workspace", async () => {
    mocks.membership.mockResolvedValue(null);
    expect(result(await callback(callbackRequest({ state: foundrState("another-workspace") })))).toBe("forbidden");
    expect(mocks.membership).toHaveBeenCalledWith({ where: { workspaceId: "another-workspace", userId: "foundr-owner-test" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the signed-in user and a managing membership", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect(result(await callback(callbackRequest()))).toBe("login_required");
    mocks.membership.mockResolvedValueOnce({ role: "MEMBER" });
    expect(result(await callback(callbackRequest()))).toBe("forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores the actual finite expiry with the matching safe receipt", async () => {
    tokenExpiry = Date.now() / 1000 + 90 * 86400;
    expect(result(await callback(callbackRequest()))).toBe("connected");
    const expiresAt = new Date(tokenExpiry * 1000);
    expect(mocks.upsert.mock.calls[0][0].update.tokenExpiresAt).toEqual(expiresAt);
    expect(mocks.receipt.mock.calls[0][0].data.payload.expiration).toEqual({
      kind: "expires_at", expiresAt: expiresAt.toISOString(),
    });
  });

  it.each(["missing", "wrong-value", "wrong-cookie", "bad-signature", "future", "expired"])(
    "rejects %s state or cookie before exchange", async (kind) => {
      let state = foundrState();
      if (kind === "future") {
        vi.setSystemTime(Date.now() + 60_000);
        state = foundrState();
        vi.setSystemTime(Date.now() - 60_000);
      }
      if (kind === "expired") vi.setSystemTime(Date.now() + 601_000);
      if (kind === "bad-signature") state += "tampered";
      const response = await callback(callbackRequest({
        state,
        cookieName: kind === "wrong-cookie" ? SERRINI_STATE_COOKIE : TARGET.stateCookie,
        cookieValue: ["missing", "wrong-value"].includes(kind) ? "" : state,
      }));
      expect(result(response)).toBe("invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a modified registered profile even with a valid signature", async () => {
    const value = parseUnifiedTargetState(createUnifiedTargetState("foundr", WORKSPACE));
    const payload = TARGET.statePrefix + Buffer.from(JSON.stringify({ ...value, contentCenterProfileId: 14 })).toString("base64url");
    expect(result(await callback(callbackRequest({ state: createOAuthState(payload) })))).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles consent denial without redeeming a code", async () => {
    expect(result(await callback(callbackRequest({ query: "error=access_denied" })))).toBe("denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a committed connection usable while webhook subscription is pending", async () => {
    mocks.subscribe.mockRejectedValue(new Error("upstream-private-response"));
    mocks.event.mockRejectedValue(new Error("event store unavailable"));
    expect(result(await callback(callbackRequest()))).toBe("connected");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.receipt).toHaveBeenCalledTimes(1);
  });

  it("preserves the two-account default transaction", async () => {
    assignedAccounts = [...SERRINI_ACCOUNTS];
    tokenExpiry = Date.now() / 1000 + 3600;
    tokenScopes = [...SERRINI_SCOPES];
    // Legacy exchanges retain their original optional positive lifetime shape.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: TOKEN })));
    mocks.profile.mockResolvedValueOnce(SERRINI_ACCOUNTS[0]).mockResolvedValueOnce(SERRINI_ACCOUNTS[1]);
    const response = await callback(callbackRequest({
      state: createOAuthState(SERRINI_STATE_PREFIX + WORKSPACE), cookieName: SERRINI_STATE_COOKIE,
    }));
    expect(result(response)).toBe("connected");
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.receipt).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(response.cookies.get(TARGET.stateCookie)).toBeUndefined();
  });
});
