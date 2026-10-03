import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  hashServiceKey,
  hasServiceKeyHeader,
  resetServiceJwksCache,
  verifyServiceKey,
} from "../lib/integrations/service-key";

const HUB_KEY = "hlk_hub_" + "a".repeat(40);
const registry = JSON.stringify({
  hub: { sha256: hashServiceKey(HUB_KEY), scopes: ["automations:write"] },
});

describe("verifyServiceKey", () => {
  it("rejects a missing header with 401", async () => {
    const result = await verifyServiceKey(null, "automations:write", registry);
    expect(result).toMatchObject({ ok: false, status: 401, code: "missing" });
  });

  it("rejects malformed keys with 401", async () => {
    for (const header of [
      "Basic abc",
      "Bearer",
      "Bearer hlk_hub_short",
      "Bearer xyz_hub_" + "a".repeat(40),
      "Bearer hlk_HUB_" + "a".repeat(40),
    ]) {
      expect(await verifyServiceKey(header, "automations:write", registry)).toMatchObject({
        ok: false,
        status: 401,
        code: "malformed",
      });
    }
  });

  it("is switched off when HOBBYLAND_SERVICE_KEYS is unset or invalid", async () => {
    expect(
      await verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", undefined)
    ).toMatchObject({ ok: false, status: 401, code: "not_configured" });
    expect(
      await verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", "{not json")
    ).toMatchObject({ ok: false, status: 401, code: "not_configured" });
  });

  it("rejects an unknown caller with 401", async () => {
    const result = await verifyServiceKey(
      "Bearer hlk_seo_" + "a".repeat(40),
      "automations:write",
      registry
    );
    expect(result).toMatchObject({ ok: false, status: 401, code: "unknown_caller" });
  });

  it("rejects a wrong key for a known caller with 401", async () => {
    const result = await verifyServiceKey(
      "Bearer hlk_hub_" + "b".repeat(40),
      "automations:write",
      registry
    );
    expect(result).toMatchObject({ ok: false, status: 401, code: "invalid_key" });
  });

  it("rejects a valid key without the scope with 403", async () => {
    const result = await verifyServiceKey(`Bearer ${HUB_KEY}`, "summary:read", registry);
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "insufficient_scope",
    });
    if (!result.ok) expect(result.error).toContain("summary:read");
  });

  it("accepts a valid key with the scope", async () => {
    expect(
      await verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", registry)
    ).toEqual({ ok: true, caller: "hub", scopes: ["automations:write"] });
  });

  it("never echoes the key in an error", async () => {
    const result = await verifyServiceKey(
      "Bearer hlk_hub_" + "b".repeat(40),
      "automations:write",
      registry
    );
    expect(JSON.stringify(result)).not.toContain("b".repeat(40));
  });

  it("detects a service key header", async () => {
    expect(hasServiceKeyHeader(`Bearer ${HUB_KEY}`)).toBe(true);
    // Identity access tokens are service credentials too.
    expect(hasServiceKeyHeader("Bearer eyJhbGciOi.eyJpc3Mi.c2ln")).toBe(true);
    expect(hasServiceKeyHeader("Bearer")).toBe(false);
    expect(hasServiceKeyHeader("Basic abc")).toBe(false);
    expect(hasServiceKeyHeader(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* HobbyLand Identity access tokens (JWT, spec section 5)                    */
/* ------------------------------------------------------------------------ */

describe("verifyServiceKey with Identity access tokens", () => {
  const ISSUER = "https://auth.hobbyland-group.com";
  const AUDIENCE = "https://openreply.up.railway.app";
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  let jwks: { keys: object[] };
  const fetchMock = vi.fn();

  beforeAll(async () => {
    // Locally generated test keys; nothing leaves the process.
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    const other = await generateKeyPair("RS256", { extractable: true });
    otherPrivateKey = other.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwks = { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] };
  });

  beforeEach(() => {
    resetServiceJwksCache();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      expect(String(url)).toBe(`${ISSUER}/jwks`);
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function token(
    claims: Record<string, unknown> = {},
    options: {
      key?: CryptoKey;
      exp?: number | string;
      iss?: string;
      aud?: string | string[];
      typ?: string;
      sub?: string;
      noIat?: boolean;
    } = {}
  ) {
    const jwt = new SignJWT({ client_id: "svc-hub", scope: "automations:write automations:read", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: options.typ ?? "at+jwt" })
      .setIssuer(options.iss ?? ISSUER)
      .setAudience(options.aud ?? AUDIENCE)
      .setSubject(options.sub ?? "svc-hub")
      .setJti("jti-1")
      .setExpirationTime(options.exp ?? "5m");
    if (!options.noIat) jwt.setIssuedAt();
    return jwt.sign(options.key ?? privateKey);
  }

  const verify = (jwt: string, scope = "automations:write", audience: string | undefined = AUDIENCE) =>
    verifyServiceKey(`Bearer ${jwt}`, scope, registry, audience);

  it("accepts a valid token; caller is client_id without svc-", async () => {
    await expect(verify(await token())).resolves.toEqual({
      ok: true,
      caller: "hub",
      scopes: ["automations:write", "automations:read"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the key set across requests", async () => {
    await verify(await token());
    await verify(await token());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an aud array that includes this system", async () => {
    const jwt = await token({}, { aud: ["https://other.example", AUDIENCE] });
    await expect(verify(jwt)).resolves.toMatchObject({ ok: true, caller: "hub" });
  });

  it("rejects a token whose header typ is not at+jwt with 401", async () => {
    for (const typ of ["JWT", "id_token+jwt"]) {
      await expect(verify(await token({}, { typ }))).resolves.toMatchObject({
        ok: false,
        status: 401,
        code: "invalid_token",
      });
    }
  });

  it("rejects a token whose sub differs from client_id (e.g. a staff token) with 401", async () => {
    await expect(verify(await token({}, { sub: "staff-1" }))).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_token",
    });
    await expect(verify(await token({ client_id: undefined }))).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_token",
    });
  });

  it("rejects a token without iat with 401", async () => {
    await expect(verify(await token({}, { noIat: true }))).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_token",
    });
  });

  it("reads HOBBYLAND_SERVICE_AUDIENCE and HOBBYLAND_SSO_ISSUER from the environment", async () => {
    vi.stubEnv("HOBBYLAND_SERVICE_AUDIENCE", AUDIENCE);
    vi.stubEnv("HOBBYLAND_SSO_ISSUER", `${ISSUER}/`);
    const result = await verifyServiceKey(`Bearer ${await token()}`, "automations:write");
    expect(result).toMatchObject({ ok: true, caller: "hub" });
  });

  it("rejects a token for another audience with 401", async () => {
    const jwt = await token({}, { aud: "https://seo.hobbyland-group.com" });
    await expect(verify(jwt)).resolves.toMatchObject({ ok: false, status: 401, code: "invalid_token" });
  });

  it("rejects a token from another issuer with 401", async () => {
    const jwt = await token({}, { iss: "https://evil.example" });
    await expect(verify(jwt)).resolves.toMatchObject({ ok: false, status: 401, code: "invalid_token" });
  });

  it("rejects an expired token with 401, allowing only 5 seconds of clock skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(await token({}, { exp: now - 30 }))).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_token",
    });
    await expect(verify(await token({}, { exp: now - 2 }))).resolves.toMatchObject({ ok: true });
  });

  it("rejects a token signed by an unknown key with 401", async () => {
    const jwt = await token({}, { key: otherPrivateKey });
    await expect(verify(jwt)).resolves.toMatchObject({ ok: false, status: 401, code: "invalid_token" });
  });

  it("rejects a token without the required scope with 403", async () => {
    const jwt = await token({ scope: "automations:read" });
    const result = await verify(jwt);
    expect(result).toMatchObject({ ok: false, status: 403, code: "insufficient_scope" });
    if (!result.ok) expect(result.error).toContain("automations:write");
    // A scope that only starts with the required one does not count.
    await expect(verify(await token({ scope: "automations:writeX" }))).resolves.toMatchObject({
      status: 403,
    });
  });

  it("rejects every token while HOBBYLAND_SERVICE_AUDIENCE is unset", async () => {
    vi.stubEnv("HOBBYLAND_SERVICE_AUDIENCE", "");
    const jwt = await token();
    // Unset in the environment (default argument) …
    expect(await verifyServiceKey(`Bearer ${jwt}`, "automations:write", registry)).toMatchObject({
      ok: false,
      status: 401,
      code: "not_configured",
    });
    // … or blank when passed explicitly.
    const result = await verify(jwt, "automations:write", "  ");
    expect(result).toMatchObject({ ok: false, status: 401, code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the key set cannot be fetched", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(verify(await token())).resolves.toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("eyJ");
    errorLog.mockRestore();
  });

  it("still accepts hlk_ keys exactly as before when JWTs are enabled", async () => {
    await expect(
      verifyServiceKey(`Bearer ${HUB_KEY}`, "automations:write", registry, AUDIENCE)
    ).resolves.toEqual({ ok: true, caller: "hub", scopes: ["automations:write"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
