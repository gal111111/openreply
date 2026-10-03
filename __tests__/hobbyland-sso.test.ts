import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "next-auth";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    account: { findUnique: vi.fn() },
    workspaceInvitation: { findMany: vi.fn() },
    workspaceMember: { findFirst: vi.fn(), upsert: vi.fn() },
    workspace: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// next-auth's runtime pulls in next/server, which vitest cannot resolve; the
// config object under test is plain data and callbacks, so stub the factory.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));

// Test-only placeholder, not a real credential (the provider needs >= 32 chars).
const CLIENT_SECRET = "test-only-placeholder-secret-0123456789abcdef";

function configureSso() {
  vi.stubEnv("HOBBYLAND_SSO_CLIENT_ID", "openreply");
  vi.stubEnv("HOBBYLAND_SSO_CLIENT_SECRET", CLIENT_SECRET);
}

function hobbylandAccount(sub = "staff-1"): Account {
  return {
    provider: "hobbyland",
    providerAccountId: sub,
    type: "oidc",
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.account.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("HobbyLand provider configuration", () => {
  it("is absent until client id and a long enough secret are set", async () => {
    const sso = await import("../lib/hobbyland-sso");
    expect(sso.hobbylandProvider()).toBeNull();

    vi.stubEnv("HOBBYLAND_SSO_CLIENT_ID", "openreply");
    expect(sso.hobbylandProvider()).toBeNull();

    vi.stubEnv("HOBBYLAND_SSO_CLIENT_SECRET", "too-short");
    expect(sso.hobbylandProvider()).toBeNull();

    vi.stubEnv("HOBBYLAND_SSO_CLIENT_SECRET", CLIENT_SECRET);
    expect(sso.hobbylandProvider()).not.toBeNull();
  });

  it("refuses a non-HTTPS issuer", async () => {
    configureSso();
    vi.stubEnv("HOBBYLAND_SSO_ISSUER", "http://auth.hobbyland-group.com");
    const sso = await import("../lib/hobbyland-sso");
    expect(sso.isHobbylandSsoConfigured()).toBe(false);
  });

  it("uses OIDC code flow with PKCE, state, nonce and client_secret_basic", async () => {
    configureSso();
    const sso = await import("../lib/hobbyland-sso");
    const provider = sso.hobbylandProvider();
    expect(provider).toMatchObject({
      id: "hobbyland",
      type: "oidc",
      issuer: "https://auth.hobbyland-group.com",
      clientId: "openreply",
      checks: ["pkce", "state", "nonce"],
      client: { token_endpoint_auth_method: "client_secret_basic" },
      authorization: { params: { scope: "openid email" } },
    });
    expect(
      provider?.profile?.(
        { sub: "staff-1", email: " Ed@HobbyLand.com ", email_verified: true },
        {}
      )
    ).toEqual({ id: "staff-1", email: "ed@hobbyland.com", name: null, image: null });
    expect(provider?.account?.({ access_token: "x", id_token: "y" } as never)).toEqual({});
  });

  it("honours a custom issuer", async () => {
    configureSso();
    vi.stubEnv("HOBBYLAND_SSO_ISSUER", "https://auth.example.test/");
    const sso = await import("../lib/hobbyland-sso");
    expect(sso.hobbylandProvider()?.issuer).toBe("https://auth.example.test");
  });

  it("is registered in the Auth.js config only when configured", async () => {
    let { authConfig } = await import("../lib/auth");
    expect(authConfig.providers.map((p) => (typeof p === "function" ? "" : p.id))).not.toContain(
      "hobbyland"
    );

    vi.resetModules();
    configureSso();
    ({ authConfig } = await import("../lib/auth"));
    const ids = authConfig.providers.map((p) => (typeof p === "function" ? "" : p.id));
    expect(ids).toContain("hobbyland");
    // Magic link stays available.
    expect(ids).toContain("resend");
  });
});

describe("HobbyLand sign-in authorization", () => {
  async function signIn(
    profile: Record<string, unknown>,
    account: Account | null = hobbylandAccount(String(profile.sub ?? "staff-1"))
  ) {
    configureSso();
    const { authConfig } = await import("../lib/auth");
    return authConfig.callbacks.signIn({
      user: { email: profile.email as string },
      account,
      profile,
    } as never);
  }

  it("denies an unverified email even for an existing user", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user_1" });
    vi.stubEnv("HOBBYLAND_SSO_ALLOWED", JSON.stringify(["ed@hobbyland.com"]));
    await expect(
      signIn({ sub: "staff-1", email: "ed@hobbyland.com", email_verified: false })
    ).resolves.toBe(false);
    await expect(signIn({ sub: "staff-1", email: "ed@hobbyland.com" })).resolves.toBe(false);
    await expect(
      signIn({ sub: "staff-1", email: "ed@hobbyland.com", email_verified: "true" })
    ).resolves.toBe(false);
  });

  it("denies a verified but unknown email", async () => {
    await expect(
      signIn({ sub: "staff-9", email: "stranger@hobbyland.com", email_verified: true })
    ).resolves.toBe(false);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "stranger@hobbyland.com" },
      select: { id: true },
    });
  });

  it("denies a missing email or a subject that does not match the account", async () => {
    vi.stubEnv("HOBBYLAND_SSO_ALLOWED", JSON.stringify(["staff-1"]));
    await expect(signIn({ sub: "staff-1", email_verified: true })).resolves.toBe(false);
    await expect(
      signIn(
        { sub: "staff-1", email: "ed@hobbyland.com", email_verified: true },
        hobbylandAccount("staff-2")
      )
    ).resolves.toBe(false);
  });

  it("allows a verified email or subject on the allow list", async () => {
    vi.stubEnv(
      "HOBBYLAND_SSO_ALLOWED",
      JSON.stringify(["New.Staff@HobbyLand.com", "staff-42"])
    );
    await expect(
      signIn({ sub: "staff-7", email: "new.staff@hobbyland.com", email_verified: true })
    ).resolves.toBe(true);
    await expect(
      signIn({ sub: "staff-42", email: "other@hobbyland.com", email_verified: true })
    ).resolves.toBe(true);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("ignores a malformed allow list", async () => {
    vi.stubEnv("HOBBYLAND_SSO_ALLOWED", "new.staff@hobbyland.com");
    await expect(
      signIn({ sub: "staff-7", email: "new.staff@hobbyland.com", email_verified: true })
    ).resolves.toBe(false);
  });

  it("allows a verified email of an existing user (case-insensitive)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user_1" });
    await expect(
      signIn({ sub: "staff-1", email: "Ed@HobbyLand.com", email_verified: true })
    ).resolves.toBe(true);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "ed@hobbyland.com" },
      select: { id: true },
    });
  });

  it("allows a subject already linked to an OpenReply user", async () => {
    mockPrisma.account.findUnique.mockResolvedValue({ id: "acc_1" });
    await expect(
      signIn({ sub: "staff-1", email: "renamed@hobbyland.com", email_verified: true })
    ).resolves.toBe(true);
  });

  it("still applies ALLOWED_EMAILS", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user_1" });
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");
    await expect(
      signIn({ sub: "staff-1", email: "ed@hobbyland.com", email_verified: true })
    ).resolves.toBe(false);
  });

  it("keeps the magic-link rule for the email provider", async () => {
    configureSso();
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");
    const { authConfig } = await import("../lib/auth");
    const callback = authConfig.callbacks.signIn;
    await expect(
      callback({ user: { email: "owner@example.com" }, account: { provider: "resend" } } as never)
    ).resolves.toBe(true);
    await expect(
      callback({ user: { email: "x@example.com" }, account: { provider: "resend" } } as never)
    ).resolves.toBe(false);
  });
});

describe("invite-only workspaces for HobbyLand users", () => {
  it("creates no workspace for a new HobbyLand user, only accepts invitations", async () => {
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
    const { authConfig } = await import("../lib/auth");
    await authConfig.events.createUser({
      user: { id: "user_new", email: "new@hobbyland.com", emailVerified: null },
    } as never);
    expect(mockPrisma.workspaceInvitation.findMany).toHaveBeenCalled();
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });

  it("returns no workspace for an invite-only user without membership", async () => {
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerified: null,
      accounts: [{ id: "acc_1" }],
    });
    const { ensureWorkspaceForUser } = await import("../lib/workspace");
    await expect(ensureWorkspaceForUser("user_new", "new@hobbyland.com")).resolves.toBeNull();
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });

  it("still creates a workspace for a magic-link user", async () => {
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerified: new Date(),
      accounts: [],
    });
    mockPrisma.workspace.create.mockResolvedValue({ id: "ws_1" });
    const { ensureWorkspaceForUser } = await import("../lib/workspace");
    await expect(ensureWorkspaceForUser("user_1", "owner@example.com")).resolves.toEqual({
      id: "ws_1",
    });
  });
});

describe("login page", () => {
  async function renderLogin(params: Record<string, string> = {}) {
    vi.doMock("@/lib/auth", () => ({ EMAIL_PROVIDER_ID: "resend", signIn: vi.fn() }));
    vi.doMock("@/lib/i18n/server", async () => {
      const { createI18n } = await import("../lib/i18n");
      return { getI18n: async () => createI18n("zh-TW") };
    });
    vi.doMock("@/components/demo-notice", () => ({ DemoNotice: () => null }));
    vi.doMock("@/lib/env", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../lib/env")>()),
      isPublicDemoHost: async () => false,
    }));
    const { default: LoginPage } = await import("../app/login/page");
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
  }

  afterEach(() => {
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/lib/i18n/server");
    vi.doUnmock("@/components/demo-notice");
    vi.doUnmock("@/lib/env");
  });

  it("hides the unified-login button when SSO is not configured", async () => {
    const html = await renderLogin();
    expect(html).not.toContain("使用 HobbyLand 統一登入");
    expect(html).toContain("寄送登入連結");
  });

  it("shows the unified-login button above the magic-link form when configured", async () => {
    configureSso();
    const html = await renderLogin();
    const sso = html.indexOf("使用 HobbyLand 統一登入");
    const magic = html.indexOf("寄送登入連結");
    expect(sso).toBeGreaterThan(-1);
    expect(magic).toBeGreaterThan(sso);
  });

  it("explains a refused sign-in", async () => {
    configureSso();
    const html = await renderLogin({ error: "AccessDenied" });
    expect(html).toContain("未能登入");
  });
});
