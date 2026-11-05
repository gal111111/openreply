import { NextResponse } from "next/server";
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

export async function GET() {
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
  const state = createOAuthState(SERRINI_STATE_PREFIX + context.workspaceId);
  const response = NextResponse.redirect(
    getSerriniAuthorizationUrl(`${base}/api/instagram/serrini/callback`, state),
  );
  response.cookies.set(SERRINI_STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(base).protocol === "https:",
    sameSite: "lax",
    path: "/api/instagram/serrini",
    maxAge: 600,
  });
  return response;
}
