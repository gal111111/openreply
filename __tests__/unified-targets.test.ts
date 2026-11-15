import { describe, expect, it, vi } from "vitest";
import { createOAuthState, verifyOAuthState } from "@/lib/meta/oauth";
import { SERRINI_ACCOUNTS, SERRINI_SCOPES } from "@/lib/meta/serrini-unified";
import {
  FOUNDR_UNIFIED_TARGET,
  createUnifiedTargetState,
  getUnifiedTarget,
  parseUnifiedTargetState,
  selectUnifiedTargetAccount,
} from "@/lib/meta/unified-targets";

const account = { id: "17841400000000013", username: "kingofhkai" };

function encodedState(overrides: Record<string, unknown> = {}) {
  const payload = {
    targetKey: "foundr",
    contentCenterProfileId: 13,
    workspaceId: "workspace-foundr-test",
    username: "kingofhkai",
    appId: "1574251267790326",
    configId: "1133446066003520",
    ...overrides,
  };
  return FOUNDR_UNIFIED_TARGET.statePrefix + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

describe("registered Foundr Unified Login target", () => {
  it("resolves the exact registered profile and application", () => {
    expect(getUnifiedTarget("foundr")).toMatchObject({
      contentCenterProfileId: 13,
      username: "kingofhkai",
      appId: "1574251267790326",
      configId: "1133446066003520",
    });
    expect(Object.isFrozen(getUnifiedTarget("foundr"))).toBe(true);
  });

  it.each([undefined, null, "serrini", "13", "kingofhkai", {}])(
    "rejects an unregistered selector %s",
    (key) => expect(() => getUnifiedTarget(key)).toThrow("Unsupported Unified Login target"),
  );

  it("round-trips inside the existing signed OAuth envelope", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "unit-test-oauth-state-secret");
    try {
      const payload = createUnifiedTargetState("foundr", "workspace-foundr-test");
      const signed = createOAuthState(payload);
      const verified = verifyOAuthState(signed);
      expect(parseUnifiedTargetState(verified?.workspaceId)).toMatchObject({
        contentCenterProfileId: 13,
        workspaceId: "workspace-foundr-test",
      });
      expect(verifyOAuthState(signed + "tampered")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { contentCenterProfileId: 14 },
    { username: "serrini666" },
    { appId: "1783163749711321" },
    { configId: "other-config" },
    { workspaceId: " " },
    { targetKey: "other" },
    { arbitraryProfileSelector: 14 },
  ])("rejects altered target state %j", (overrides) => {
    expect(() => parseUnifiedTargetState(encodedState(overrides))).toThrow(
      "Invalid Unified Login target state",
    );
  });

  it.each([null, "", "serrini-unified:workspace", "foundr-unified:invalid-json"])(
    "rejects malformed or unrelated state %s",
    (state) => expect(() => parseUnifiedTargetState(state)).toThrow("Invalid Unified Login target state"),
  );

  it("selects only the registered account from mixed assigned assets", () => {
    expect(selectUnifiedTargetAccount("foundr", [...SERRINI_ACCOUNTS, account])).toEqual(account);
  });

  it("normalizes the case of the verified username", () => {
    expect(selectUnifiedTargetAccount("foundr", [{ ...account, username: "KingOfHKAI" }])).toEqual(account);
  });

  it("handles the same assigned asset repeated across pages", () => {
    expect(selectUnifiedTargetAccount("foundr", [account, { ...account }])).toEqual(account);
  });

  it.each([{ assets: [] }, { assets: [...SERRINI_ACCOUNTS] }])("rejects a missing Foundr asset %j", ({ assets }) => {
    expect(() => selectUnifiedTargetAccount("foundr", assets)).toThrow("missing or ambiguous");
  });

  it("rejects two canonical identities for the same expected username", () => {
    expect(() => selectUnifiedTargetAccount("foundr", [account, { ...account, id: "17841400000000014" }]))
      .toThrow("missing or ambiguous");
  });

  it("preserves an existing canonical account binding", () => {
    expect(selectUnifiedTargetAccount("foundr", [account], account.id)).toEqual(account);
    expect(() => selectUnifiedTargetAccount("foundr", [account], "17841400000000014"))
      .toThrow("account binding changed");
  });

  it.each([
    { assets: [{ ...account, id: Number(account.id) }] },
    { assets: [{ ...account, id: "0" }] },
    { assets: null },
  ])(
    "rejects malformed canonical identifiers %j",
    ({ assets }) => expect(() => selectUnifiedTargetAccount("foundr", assets)).toThrow("Invalid assigned Instagram accounts"),
  );

  it("preserves the two existing Serrini defaults and required permissions", () => {
    expect(SERRINI_ACCOUNTS).toEqual([
      { id: "17841415718399486", username: "serrinion" },
      { id: "17841480865798985", username: "serrini666" },
    ]);
    expect(FOUNDR_UNIFIED_TARGET.requiredScopes).toEqual(SERRINI_SCOPES);
    expect(Object.isFrozen(FOUNDR_UNIFIED_TARGET.requiredScopes)).toBe(true);
  });
});
