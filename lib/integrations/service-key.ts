import { createHash, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { NextResponse } from "next/server";

/**
 * HobbyLand service-to-service authentication.
 *
 * Two credentials are accepted in `Authorization: Bearer <credential>`:
 *
 * 1. Service keys (integration spec v1, section 0): `hlk_<caller>_<secret>`
 *    with a 32+ character secret. The receiver only stores the sha256 hex of
 *    the whole key, in HOBBYLAND_SERVICE_KEYS:
 *      {"hub": {"sha256": "<hex>", "scopes": ["automations:write"]}}
 *
 * 2. Access tokens from HobbyLand Identity (spec section 5, step 3): RS256
 *    JWTs from the client_credentials grant, verified against
 *    `<issuer>/jwks`. iss must equal the issuer, aud must include
 *    HOBBYLAND_SERVICE_AUDIENCE (this system's origin) and scope must include
 *    the required scope (exact match per space-separated item). The header
 *    typ must be "at+jwt" and sub must equal client_id, so a staff ID token
 *    from the same issuer is never accepted. Without
 *    HOBBYLAND_SERVICE_AUDIENCE no JWT is accepted. The caller name is
 *    client_id without "svc-".
 */

export const SERVICE_KEY_PREFIX = "hlk_";

const KEY_PATTERN = /^hlk_([a-z0-9]+)_([A-Za-z0-9_-]{32,})$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type ServiceKeyErrorCode =
  | "missing"
  | "malformed"
  | "not_configured"
  | "unknown_caller"
  | "invalid_key"
  | "insufficient_scope"
  | "invalid_token";

export type ServiceKeyError = {
  ok: false;
  status: 401 | 403;
  code: ServiceKeyErrorCode;
  error: string;
};

export type ServiceKeyCaller = {
  ok: true;
  caller: string;
  scopes: string[];
};

export type ServiceKeyResult = ServiceKeyCaller | ServiceKeyError;

type RegisteredKey = { sha256: string; scopes: string[] };

function fail(
  status: 401 | 403,
  code: ServiceKeyErrorCode,
  error: string
): ServiceKeyError {
  return { ok: false, status, code, error };
}

/**
 * Parse HOBBYLAND_SERVICE_KEYS. Returns null when it is unset or unusable, so
 * service-key access is switched off rather than half working.
 */
export function readServiceKeyRegistry(
  raw: string | undefined = process.env.HOBBYLAND_SERVICE_KEYS
): Map<string, RegisteredKey> | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[service-key] HOBBYLAND_SERVICE_KEYS 不是有效的 JSON，系統鑰匙功能已停用。");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[service-key] HOBBYLAND_SERVICE_KEYS 格式不正確，系統鑰匙功能已停用。");
    return null;
  }

  const registry = new Map<string, RegisteredKey>();
  for (const [caller, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { sha256, scopes } = entry as { sha256?: unknown; scopes?: unknown };
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256.toLowerCase())) {
      console.error(`[service-key] 呼叫方「${caller}」的 sha256 格式不正確，已略過。`);
      continue;
    }
    registry.set(caller, {
      sha256: sha256.toLowerCase(),
      scopes: Array.isArray(scopes)
        ? scopes.filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return registry;
}

export function hashServiceKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * True when the request carries a Bearer credential (an hlk_ service key or a
 * HobbyLand Identity access token) rather than relying on a browser session.
 */
export function hasServiceKeyHeader(authorization: string | null | undefined) {
  return Boolean(authorization && /^bearer\s+\S/i.test(authorization.trim()));
}

/** hlk_ service key path (unchanged from integration spec v1). */
function verifyHlkKey(
  key: string,
  requiredScope: string,
  rawRegistry: string | undefined
): ServiceKeyResult {
  const parts = key.match(KEY_PATTERN);
  if (!parts) {
    return fail(401, "malformed", "系統鑰匙格式不正確。");
  }
  const caller = parts[1];

  const registry = readServiceKeyRegistry(rawRegistry);
  if (!registry) {
    return fail(401, "not_configured", "本系統尚未設定系統鑰匙，無法以系統鑰匙存取。");
  }

  const registered = registry.get(caller);
  if (!registered) {
    return fail(401, "unknown_caller", "系統鑰匙未登記。");
  }

  const actual = Buffer.from(hashServiceKey(key), "hex");
  const expected = Buffer.from(registered.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return fail(401, "invalid_key", "系統鑰匙無效。");
  }

  if (!registered.scopes.includes(requiredScope)) {
    return fail(403, "insufficient_scope", `系統鑰匙沒有「${requiredScope}」權限。`);
  }

  return { ok: true, caller, scopes: [...registered.scopes] };
}

/* ------------------------------------------------------------------------ */
/* HobbyLand Identity access tokens (JWT)                                    */
/* ------------------------------------------------------------------------ */

export const DEFAULT_HOBBYLAND_ISSUER = "https://auth.hobbyland-group.com";
const CLOCK_TOLERANCE_SECONDS = 5;
/** Identity marks access tokens with this header type (RFC 9068). */
const ACCESS_TOKEN_TYP = "at+jwt";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** HOBBYLAND_SSO_ISSUER without a trailing slash, or null when unusable. */
export function readServiceIssuer(
  raw: string | undefined = process.env.HOBBYLAND_SSO_ISSUER
): string | null {
  const value = raw?.trim() || DEFAULT_HOBBYLAND_ISSUER;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

// One remote key set per issuer for the life of the process; jose caches the
// keys inside it and refetches on an unknown kid (rate-limited).
let jwksCache: { url: string; keySet: ReturnType<typeof createRemoteJWKSet> } | null = null;

function remoteKeySet(issuer: string) {
  const url = `${issuer}/jwks`;
  if (!jwksCache || jwksCache.url !== url) {
    jwksCache = { url, keySet: createRemoteJWKSet(new URL(url)) };
  }
  return jwksCache.keySet;
}

/** Test seam: forget the cached key set. */
export function resetServiceJwksCache() {
  jwksCache = null;
}

/**
 * client_id without "svc-", or null unless client_id is present and equal to
 * sub (true for client_credentials tokens, false for staff tokens).
 */
function callerFromPayload(payload: JWTPayload): string | null {
  const clientId = payload.client_id;
  if (typeof clientId !== "string" || !clientId || payload.sub !== clientId) return null;
  const caller = clientId.startsWith("svc-") ? clientId.slice(4) : clientId;
  return caller ? caller : null;
}

async function verifyIdentityToken(
  token: string,
  requiredScope: string,
  audienceRaw: string | undefined
): Promise<ServiceKeyResult> {
  if (!JWT_SHAPE.test(token)) {
    return fail(401, "malformed", "系統鑰匙格式不正確。");
  }
  const audience = audienceRaw?.trim();
  if (!audience) {
    return fail(401, "not_configured", "本系統尚未設定 HOBBYLAND_SERVICE_AUDIENCE，不接受系統存取權杖。");
  }
  const issuer = readServiceIssuer();
  if (!issuer) {
    console.error("[service-key] HOBBYLAND_SSO_ISSUER 格式不正確，不接受系統存取權杖。");
    return fail(401, "not_configured", "本系統的統一登入發行者設定不正確，不接受系統存取權杖。");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, remoteKeySet(issuer), {
      algorithms: ["RS256"],
      issuer,
      audience,
      typ: ACCESS_TOKEN_TYP,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "iat", "sub", "client_id"],
    }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return fail(401, "invalid_token", "系統存取權杖已過期。");
    }
    if (
      !(error instanceof joseErrors.JWTClaimValidationFailed) &&
      !(error instanceof joseErrors.JWSSignatureVerificationFailed) &&
      !(error instanceof joseErrors.JWSInvalid) &&
      !(error instanceof joseErrors.JWTInvalid) &&
      !(error instanceof joseErrors.JOSEAlgNotAllowed) &&
      !(error instanceof joseErrors.JWKSNoMatchingKey)
    ) {
      // Key set unreachable or unreadable; never log the token itself.
      console.error(
        "[service-key] 無法驗證系統存取權杖：",
        (error as { code?: string; name?: string })?.code ?? (error as Error)?.name
      );
    }
    return fail(401, "invalid_token", "系統存取權杖無效。");
  }

  const caller = callerFromPayload(payload);
  if (!caller) {
    return fail(401, "invalid_token", "系統存取權杖的呼叫方資料不正確。");
  }
  const scopes =
    typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
  if (!scopes.includes(requiredScope)) {
    return fail(403, "insufficient_scope", `系統存取權杖沒有「${requiredScope}」權限。`);
  }
  return { ok: true, caller, scopes };
}

/**
 * Verify a service credential (hlk_ key or Identity access token) and check
 * it carries `requiredScope`. 401 for a missing, malformed, unregistered,
 * wrong or expired credential; 403 when it is valid but lacks the scope.
 */
export async function verifyServiceKey(
  authorization: string | null | undefined,
  requiredScope: string,
  rawRegistry: string | undefined = process.env.HOBBYLAND_SERVICE_KEYS,
  audience: string | undefined = process.env.HOBBYLAND_SERVICE_AUDIENCE
): Promise<ServiceKeyResult> {
  if (!authorization || !authorization.trim()) {
    return fail(401, "missing", "缺少系統鑰匙，請在 Authorization 標頭提供 Bearer 鑰匙。");
  }

  const match = authorization.trim().match(/^Bearer\s+(\S+)$/i);
  const credential = match?.[1];
  if (!credential) {
    return fail(401, "malformed", "系統鑰匙格式不正確。");
  }
  if (credential.startsWith(SERVICE_KEY_PREFIX)) {
    return verifyHlkKey(credential, requiredScope, rawRegistry);
  }
  return verifyIdentityToken(credential, requiredScope, audience);
}

export function serviceKeyErrorResponse(result: ServiceKeyError) {
  return NextResponse.json(
    { error: result.error },
    { status: result.status, headers: { "Cache-Control": "no-store" } }
  );
}
