import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUnifiedConnectionReceipt,
  createUnifiedTokenExpiration,
  parseUnifiedConnectionHandoff,
} from "@/lib/integrations/unified-connection-handoff";
import { FOUNDR_UNIFIED_TARGET } from "@/lib/meta/unified-targets";

const WORKSPACE = "workspace-foundr-test";
const SECRET = "unit-test-private-account-credential";

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    targetKey: "foundr",
    contentCenterProfileId: 13,
    workspaceId: WORKSPACE,
    username: "kingofhkai",
    appId: "1574251267790326",
    configId: "1133446066003520",
    platform: "instagram",
    openReplyAccountId: "connection-foundr-test",
    instagramId: "17841400000000013",
    clientBusinessId: "2226123804613304",
    loginMode: "UNIFIED",
    expiration: { kind: "never" },
    scopes: [...FOUNDR_UNIFIED_TARGET.requiredScopes],
    verifiedAt: "2026-11-15T06:00:00.000Z",
    accessToken: SECRET,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T06:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("Foundr server-to-server connection handoff", () => {
  it("maps Meta's exact zero expiration to an explicit non-expiring kind", () => {
    expect(createUnifiedTokenExpiration(0)).toEqual({ kind: "never" });
  });

  it("maps a future Meta Unix expiration to an ISO timestamp", () => {
    const expiresAt = "2027-06-15T06:00:00.000Z";
    expect(createUnifiedTokenExpiration(Date.parse(expiresAt) / 1000))
      .toEqual({ kind: "expires_at", expiresAt });
  });

  it.each([undefined, null, "", "0", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects an unknown or invalid Meta expiration %s",
    (value) => expect(() => createUnifiedTokenExpiration(value))
      .toThrow("Invalid Unified Login token expiration"),
  );

  it("rejects an expired Meta Unix timestamp", () => {
    expect(() => createUnifiedTokenExpiration(Date.now() / 1000 - 1))
      .toThrow("token has expired");
  });

  it("accepts an explicitly non-expiring Unified business credential", () => {
    expect(parseUnifiedConnectionHandoff(handoff(), WORKSPACE)).toMatchObject({
      contentCenterProfileId: 13,
      loginMode: "UNIFIED",
      expiration: { kind: "never" },
    });
  });

  it("accepts the verified finite lifetime without a legacy 60-day cap", () => {
    const expiration = { kind: "expires_at", expiresAt: "2027-06-15T06:00:00.000Z" };
    expect(parseUnifiedConnectionHandoff(handoff({ expiration }), WORKSPACE).expiration)
      .toEqual(expiration);
  });

  it.each([
    { contentCenterProfileId: 14 },
    { workspaceId: "different-workspace" },
    { username: "serrinion" },
    { appId: "1783163749711321" },
    { configId: "other-config" },
    { targetKey: "other" },
    { platform: "facebook" },
    { loginMode: "INSTAGRAM" },
    { instagramId: Number("17841400000000013") },
    { instagramId: "0" },
    { clientBusinessId: "" },
    { accessToken: " " },
    { expiration: null },
    { expiration: { kind: "unknown" } },
    { expiration: { kind: "never", arbitraryLifetime: true } },
    { unexpectedCredential: SECRET },
  ])("rejects an out-of-contract handoff %j", (overrides) => {
    expect(() => parseUnifiedConnectionHandoff(handoff(overrides), WORKSPACE))
      .toThrow("Invalid Unified Login connection handoff");
  });

  it("requires the receiver's authenticated workspace context", () => {
    expect(() => parseUnifiedConnectionHandoff(handoff(), "different-workspace"))
      .toThrow("Invalid Unified Login connection handoff");
  });

  it("rejects expired credentials before persistence", () => {
    const expiration = { kind: "expires_at", expiresAt: "2026-11-15T05:59:59.000Z" };
    expect(() => parseUnifiedConnectionHandoff(handoff({ expiration }), WORKSPACE))
      .toThrow("connection has expired");
  });

  it("requires all five configured Instagram permissions", () => {
    const scopes = FOUNDR_UNIFIED_TARGET.requiredScopes.filter((scope) => scope !== "instagram_content_publish");
    expect(() => parseUnifiedConnectionHandoff(handoff({ scopes }), WORKSPACE))
      .toThrow("permissions are incomplete");
  });

  it("builds a credential-free public receipt", () => {
    const receipt = createUnifiedConnectionReceipt(handoff(), WORKSPACE);
    expect(receipt).not.toHaveProperty("accessToken");
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(receipt.connectionVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.contentCenterProfileId).toBe(13);
    expect(receipt.openReplyAccountId).toBe("connection-foundr-test");
  });

  it("keeps retry versions stable across scope ordering and fresh verification", () => {
    const initial = createUnifiedConnectionReceipt(handoff(), WORKSPACE);
    const retry = createUnifiedConnectionReceipt(handoff({
      scopes: [...FOUNDR_UNIFIED_TARGET.requiredScopes].reverse(),
      verifiedAt: "2026-11-15T06:01:00.000Z",
    }), WORKSPACE);
    expect(retry.connectionVersion).toBe(initial.connectionVersion);
  });

  it("changes the safe version when the private credential changes", () => {
    const initial = createUnifiedConnectionReceipt(handoff(), WORKSPACE);
    const rotated = createUnifiedConnectionReceipt(handoff({ accessToken: "unit-test-rotated-credential" }), WORKSPACE);
    expect(rotated.connectionVersion).not.toBe(initial.connectionVersion);
  });

  it("keeps validation errors safe for operational logging", () => {
    try {
      createUnifiedConnectionReceipt(handoff({ configId: SECRET }), WORKSPACE);
      throw new Error("Expected the invalid handoff to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Invalid Unified Login connection handoff");
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
  });
});
