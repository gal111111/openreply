import { requireEnv } from "@/lib/env";
import { type MetaCredential } from "./credentials";
import { z } from "zod";

export const SERRINI_STATE_COOKIE = "serrini_instagram_oauth";
export const SERRINI_STATE_PREFIX = "serrini-unified:";
export const SERRINI_HANDLES = new Set(["serrinion", "serrini666"]);
export const SERRINI_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "instagram_manage_insights",
];
const GRAPH = "https://graph.facebook.com/v27.0";
const id = z.string().regex(/^\d+$/);
const accountSchema = z.object({ id, username: z.string().min(1) });

export class SerriniConnectionError extends Error {
  constructor(readonly step: string, readonly graphCode: number, readonly reason = "unspecified") {
    super(`Serrini ${step} failed (${graphCode})`);
  }
}

export function serriniFailureDiagnostic(error: unknown): string {
  if (error instanceof SerriniConnectionError)
    return `${error.step}:graph_${error.graphCode}:${error.reason}`;
  if (error instanceof z.ZodError)
    return `response_shape:${error.issues.map((issue) => issue.path.join(".")).join(",")}`;
  // Never persist upstream messages or request URLs, which may contain tokens.
  return "unexpected_failure";
}

async function graphJson(path: string, token: string, step: string) {
  const response = await fetch(`${GRAPH}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    // Meta error text can contain request data. Persist only its numeric code.
    throw new SerriniConnectionError(step, Number(data.error?.code) || response.status);
  }
  return data;
}

export function getSerriniAuthorizationUrl(
  redirectUri: string,
  state: string,
): string {
  const url = new URL("https://www.facebook.com/dialog/oauth");
  url.search = new URLSearchParams({
    client_id: requireEnv("SERRINI_META_APP_ID"),
    config_id: requireEnv("SERRINI_META_CONFIG_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    display: "popup",
    override_default_response_type: "true",
    prompt: "login",
    state,
  }).toString();
  return url.toString();
}

export async function exchangeSerriniCode(code: string, redirectUri: string) {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: requireEnv("SERRINI_META_APP_ID"),
    client_secret: requireEnv("SERRINI_META_APP_SECRET"),
    code,
    redirect_uri: redirectUri,
  }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    const message = String(data.error?.message || "").toLowerCase();
    const reason = ["redirect_uri", "client_secret", "client_id", "verification code", "expired", "already used", "not allowed", "not published", "invalid code", "appsecret_proof"]
      .find((term) => message.includes(term)) || "unspecified";
    throw new SerriniConnectionError("token_exchange", Number(data.error?.code) || response.status, reason.replaceAll(" ", "_"));
  }
  return z
    .object({
      access_token: z.string().min(1),
      expires_in: z.number().positive().optional(),
    })
    .parse(data);
}

export async function getSerriniAssets(accessToken: string) {
  const [business, debug] = await Promise.all([
    graphJson("me?fields=client_business_id", accessToken, "business_read"),
    graphJson(
      `debug_token?input_token=${encodeURIComponent(accessToken)}`,
      `${requireEnv("SERRINI_META_APP_ID")}|${requireEnv("SERRINI_META_APP_SECRET")}`,
      "token_debug",
    ),
  ]);
  const businessId = id.parse(business.client_business_id);
  if (businessId !== requireEnv("SERRINI_META_BUSINESS_ID")) {
    throw new Error("The selected business is outside Serrini");
  }
  const token = z
    .object({
      data: z.object({
        is_valid: z.literal(true),
        app_id: id,
        scopes: z.array(z.string()),
        expires_at: z.number().positive(),
      }),
    })
    .parse(debug).data;
  if (
    token.app_id !== requireEnv("SERRINI_META_APP_ID") ||
    !SERRINI_SCOPES.every((scope) => token.scopes.includes(scope))
  ) {
    throw new Error("Serrini app permissions are incomplete");
  }
  const accounts: z.infer<typeof accountSchema>[] = [];
  let path: string | null =
    "me/assigned_instagram_accounts?fields=id,username&limit=100";
  const cursors = new Set<string>();
  while (path) {
    const page = await graphJson(path, accessToken, "assigned_accounts");
    accounts.push(...z.array(accountSchema).parse(page.data));
    const after = page.paging?.cursors?.after;
    if (!page.paging?.next || typeof after !== "string" || cursors.has(after))
      break;
    cursors.add(after);
    path = `me/assigned_instagram_accounts?fields=id,username&limit=100&after=${encodeURIComponent(after)}`;
    if (cursors.size >= 20)
      throw new Error("Assigned Instagram account listing exceeded its limit");
  }
  const selected = accounts.filter((account) =>
    SERRINI_HANDLES.has(account.username.toLowerCase()),
  );
  if (!selected.length)
    throw new Error("No approved Serrini Instagram account was selected");
  if (token.expires_at * 1000 <= Date.now())
    throw new Error("Serrini token has expired");
  return {
    businessId,
    accounts: selected,
    scopes: token.scopes,
    expiresAt: new Date(token.expires_at * 1000),
  };
}

export function serriniCredential(
  accessToken: string,
  instagramId: string,
): MetaCredential {
  return { accessToken, instagramId, loginMode: "UNIFIED" };
}
