import { NextRequest, NextResponse } from "next/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";
import {
  getSerriniAuthorizationUrl,
  SERRINI_STATE_COOKIE,
  SERRINI_STATE_PREFIX,
} from "@/lib/meta/serrini-unified";
import { createUnifiedTargetState, getUnifiedTarget } from "@/lib/meta/unified-targets";

export async function GET(request: NextRequest) {
  const base = getBaseUrl();
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${base}/login`);
  if (!canManageWorkspace(context.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const required = [
    "SERRINI_META_APP_ID",
    "SERRINI_META_APP_SECRET",
    "SERRINI_META_CONFIG_ID",
    "SERRINI_META_BUSINESS_ID",
    "ENCRYPTION_KEY",
    "NEXTAUTH_SECRET",
  ];
  if (required.some((name) => !process.env[name])) {
    return NextResponse.json(
      { error: "Serrini connection configuration is incomplete" },
      { status: 503 },
    );
  }
  const targetKey = request.nextUrl.searchParams.get("target");
  let target: ReturnType<typeof getUnifiedTarget> | null = null;
  if (targetKey !== null) {
    try {
      target = getUnifiedTarget(targetKey);
    } catch {
      return NextResponse.json({ error: "Unsupported connection target" }, { status: 400 });
    }
  }
  if (target?.key === "talent" && context.workspaceId !== target.workspaceId) {
    return NextResponse.json({ error: "Connection target is outside this workspace" }, { status: 403 });
  }
  const payload = target
    ? createUnifiedTargetState(target.key, context.workspaceId)
    : SERRINI_STATE_PREFIX + context.workspaceId;
  const state = createOAuthState(payload);
  let authorizationUrl: string;
  try {
    authorizationUrl = getSerriniAuthorizationUrl(
      `${base}/api/instagram/serrini/callback`, state, target?.key,
    );
  } catch {
    return NextResponse.json({ error: "Connection target configuration is incomplete" }, { status: 503 });
  }
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(target?.stateCookie ?? SERRINI_STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(base).protocol === "https:",
    sameSite: "lax",
    path: "/api/instagram/serrini",
    maxAge: 600,
  });
  return response;
}
