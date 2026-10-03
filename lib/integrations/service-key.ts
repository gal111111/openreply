import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

/**
 * HobbyLand service keys (integration spec v1, section 0).
 *
 * Header: `Authorization: Bearer hlk_<caller>_<secret>` with a 32+ character
 * secret. The receiver only stores the sha256 hex of the whole key, in
 * HOBBYLAND_SERVICE_KEYS:
 *   {"hub": {"sha256": "<hex>", "scopes": ["automations:write"]}}
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
  | "insufficient_scope";

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

/** True when the header carries a HobbyLand service key rather than nothing. */
export function hasServiceKeyHeader(authorization: string | null | undefined) {
  return Boolean(
    authorization &&
      authorization.trim().toLowerCase().startsWith(`bearer ${SERVICE_KEY_PREFIX}`)
  );
}

/**
 * Verify a service key and check it carries `requiredScope`.
 * 401 for a missing, malformed, unregistered or wrong key; 403 when the key is
 * valid but lacks the scope.
 */
export function verifyServiceKey(
  authorization: string | null | undefined,
  requiredScope: string,
  rawRegistry: string | undefined = process.env.HOBBYLAND_SERVICE_KEYS
): ServiceKeyResult {
  if (!authorization || !authorization.trim()) {
    return fail(401, "missing", "缺少系統鑰匙，請在 Authorization 標頭提供 Bearer 鑰匙。");
  }

  const match = authorization.trim().match(/^Bearer\s+(\S+)$/i);
  const key = match?.[1];
  const parts = key ? key.match(KEY_PATTERN) : null;
  if (!key || !parts) {
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

export function serviceKeyErrorResponse(result: ServiceKeyError) {
  return NextResponse.json(
    { error: result.error },
    { status: result.status, headers: { "Cache-Control": "no-store" } }
  );
}
