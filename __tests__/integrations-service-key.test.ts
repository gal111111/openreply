import { describe, expect, it } from "vitest";
import {
  hashServiceKey,
  hasServiceKeyHeader,
  verifyServiceKey,
} from "../lib/integrations/service-key";

const HUB_KEY = "hlk_hub_" + "a".repeat(40);
const registry = JSON.stringify({
  hub: { sha256: hashServiceKey(HUB_KEY), scopes: ["automations:write"] },
});

describe("verifyServiceKey", () => {
  it("rejects a missing header with 401", () => {
    const result = verifyServiceKey(null, "automations:write", registry);
    expect(result).toMatchObject({ ok: false, status: 401, code: "missing" });
  });

  it("rejects malformed keys with 401", () => {
    for (const header of [
      "Basic abc",
      "Bearer",
      "Bearer hlk_hub_short",
      "Bearer xyz_hub_" + "a".repeat(40),
      "Bearer hlk_HUB_" + "a".repeat(40),
    ]) {
      expect(verifyServiceKey(header, "automations:write", registry)).toMatchObject({
        ok: false,
        status: 401,
        code: "malformed",
      });
    }
  });

  it("is switched off when HOBBYLAND_SERVICE_KEYS is unset or invalid", () => {
    expect(
      verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", undefined)
    ).toMatchObject({ ok: false, status: 401, code: "not_configured" });
    expect(
      verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", "{not json")
    ).toMatchObject({ ok: false, status: 401, code: "not_configured" });
  });

  it("rejects an unknown caller with 401", () => {
    const result = verifyServiceKey(
      "Bearer hlk_seo_" + "a".repeat(40),
      "automations:write",
      registry
    );
    expect(result).toMatchObject({ ok: false, status: 401, code: "unknown_caller" });
  });

  it("rejects a wrong key for a known caller with 401", () => {
    const result = verifyServiceKey(
      "Bearer hlk_hub_" + "b".repeat(40),
      "automations:write",
      registry
    );
    expect(result).toMatchObject({ ok: false, status: 401, code: "invalid_key" });
  });

  it("rejects a valid key without the scope with 403", () => {
    const result = verifyServiceKey(`Bearer ${HUB_KEY}`, "summary:read", registry);
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "insufficient_scope",
    });
    if (!result.ok) expect(result.error).toContain("summary:read");
  });

  it("accepts a valid key with the scope", () => {
    expect(
      verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", registry)
    ).toEqual({ ok: true, caller: "hub", scopes: ["automations:write"] });
  });

  it("never echoes the key in an error", () => {
    const result = verifyServiceKey(
      "Bearer hlk_hub_" + "b".repeat(40),
      "automations:write",
      registry
    );
    expect(JSON.stringify(result)).not.toContain("b".repeat(40));
  });

  it("detects a service key header", () => {
    expect(hasServiceKeyHeader(`Bearer ${HUB_KEY}`)).toBe(true);
    expect(hasServiceKeyHeader("Bearer something-else")).toBe(false);
    expect(hasServiceKeyHeader(null)).toBe(false);
  });
});
