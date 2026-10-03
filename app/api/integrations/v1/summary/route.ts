import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { resolveWorkspace } from "@/lib/integrations/resolve-target";
import {
  hasServiceKeyHeader,
  serviceKeyErrorResponse,
  verifyServiceKey,
} from "@/lib/integrations/service-key";

// HobbyLand integration spec v1, section 3: to-do counts for the App portal.
// Accepts the user's own session cookie, or a service key with summary:read.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const FAILED_DM_WINDOW_MS = 24 * 60 * 60 * 1000;

type SummaryItem = { title: string; count: number; url: string };

/**
 * Workspaces the request may see: the signed-in user's memberships, or for a
 * service key the requested / default workspace (all workspaces when neither
 * is set). Returns a Response when the request is not allowed.
 */
async function resolveScope(
  request: NextRequest
): Promise<{ workspaceIds: string[] | null } | NextResponse> {
  const authorization = request.headers.get("authorization");

  if (hasServiceKeyHeader(authorization)) {
    const auth = verifyServiceKey(authorization, "summary:read");
    if (!auth.ok) return serviceKeyErrorResponse(auth);

    const requested = request.nextUrl.searchParams.get("workspace");
    if (!requested && !process.env.OPENREPLY_DEFAULT_WORKSPACE?.trim()) {
      return { workspaceIds: null };
    }
    const workspace = await resolveWorkspace(requested);
    if (!workspace.ok) {
      return NextResponse.json(
        { error: workspace.error },
        { status: workspace.status, headers: NO_STORE }
      );
    }
    return { workspaceIds: [workspace.value.id] };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "需要登入。" },
      { status: 401, headers: NO_STORE }
    );
  }
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  });
  return { workspaceIds: memberships.map((m) => m.workspaceId) };
}

export async function GET(request: NextRequest) {
  const scope = await resolveScope(request);
  if (scope instanceof NextResponse) return scope;

  const workspaceFilter =
    scope.workspaceIds === null ? {} : { workspaceId: { in: scope.workspaceIds } };
  const now = new Date();
  const since = new Date(now.getTime() - FAILED_DM_WINDOW_MS);
  const baseUrl = getBaseUrl().replace(/\/$/, "");

  const [failedDms, brokenAccounts] =
    scope.workspaceIds !== null && scope.workspaceIds.length === 0
      ? [0, 0]
      : await Promise.all([
          // A DM is marked FAILED once its retries are used up; updatedAt is
          // when that happened.
          prisma.dmLog.count({
            where: {
              ...workspaceFilter,
              status: "FAILED",
              updatedAt: { gte: since },
            },
          }),
          // Same rule as hasInstagramCredentials(): Meta needs a live token,
          // Zernio needs its account link.
          prisma.instagramAccount.count({
            where: {
              ...workspaceFilter,
              OR: [
                { provider: "META", accessToken: "" },
                { provider: "META", tokenExpiresAt: { lt: now } },
                { provider: "ZERNIO", zernioAccountId: null },
              ],
            },
          }),
        ]);

  const items: SummaryItem[] = [];
  if (failedDms > 0) {
    items.push({
      title: `最近 24 小時發送失敗的私訊 ${failedDms} 則`,
      count: failedDms,
      url: `${baseUrl}/logs`,
    });
  }
  if (brokenAccounts > 0) {
    items.push({
      title: `Instagram 帳號連線失效 ${brokenAccounts} 個，需要重新連線`,
      count: brokenAccounts,
      url: `${baseUrl}/settings`,
    });
  }

  return NextResponse.json(
    {
      system: "openreply",
      count: failedDms + brokenAccounts,
      items,
      updated_at: now.toISOString(),
    },
    { headers: NO_STORE }
  );
}
