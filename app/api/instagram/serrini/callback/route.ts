import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl, requireEnv } from "@/lib/env";
import { canManageWorkspace } from "@/lib/workspace-access";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import {
  getUserInfo,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import {
  exchangeSerriniCode,
  getSerriniAssets,
  serriniCredential,
  SERRINI_HANDLES,
  SERRINI_STATE_COOKIE,
  SERRINI_STATE_PREFIX,
} from "@/lib/meta/serrini-unified";

export async function GET(request: NextRequest) {
  const base = getBaseUrl();
  function finish(result: string) {
    const response = NextResponse.redirect(
      `${base}/settings?serrini=${result}`,
    );
    response.cookies.set(SERRINI_STATE_COOKIE, "", {
      path: "/api/instagram/serrini",
      maxAge: 0,
    });
    return response;
  }
  const raw = request.nextUrl.searchParams.get("state");
  const cookie = request.cookies.get(SERRINI_STATE_COOKIE)?.value;
  if (
    !raw ||
    !cookie ||
    Buffer.byteLength(raw) !== Buffer.byteLength(cookie) ||
    !timingSafeEqual(Buffer.from(raw), Buffer.from(cookie))
  )
    return finish("invalid");
  const state = verifyOAuthState(raw);
  if (
    !state ||
    !state.workspaceId.startsWith(SERRINI_STATE_PREFIX) ||
    state.ts > Date.now()
  )
    return finish("invalid");
  const workspaceId = state.workspaceId.slice(SERRINI_STATE_PREFIX.length);
  const session = await auth();
  if (!session?.user?.id) return finish("login_required");
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role))
    return finish("forbidden");
  if (request.nextUrl.searchParams.has("error")) return finish("denied");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return finish("invalid");
  try {
    const token = await exchangeSerriniCode(code);
    const assets = await getSerriniAssets(token.access_token);
    const profiles = await Promise.all(
      assets.accounts.map(async (account) => {
        const profile = await getUserInfo(
          serriniCredential(token.access_token, account.id),
        );
        if (
          profile.id !== account.id ||
          !SERRINI_HANDLES.has(profile.username.toLowerCase()) ||
          profile.username.toLowerCase() !== account.username.toLowerCase()
        ) {
          throw new Error(
            "Instagram account identity does not match the assigned asset",
          );
        }
        return profile;
      }),
    );
    const encryptedToken = encryptToken(token.access_token);
    // All selected accounts commit together. A conflicting existing owner aborts
    // the transaction before either account receives a new credential.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('serrini-unified-connect'))`;
      for (const profile of profiles) {
        const existing = await tx.instagramAccount.findUnique({
          where: { instagramId: profile.id },
        });
        if (
          existing &&
          (existing.workspaceId !== workspaceId ||
            existing.provider !== "META" ||
            (existing.metaAppId &&
              existing.metaAppId !== requireEnv("SERRINI_META_APP_ID")))
        ) {
          throw new Error(
            "An Instagram account is already bound to another connection",
          );
        }
        const data = {
          username: profile.username,
          name: profile.name,
          accessToken: encryptedToken,
          tokenExpiresAt: assets.expiresAt,
          metaLoginMode: "UNIFIED",
          metaAppId: requireEnv("SERRINI_META_APP_ID"),
          metaBusinessId: assets.businessId,
          metaConfigId: requireEnv("SERRINI_META_CONFIG_ID"),
          webhookSubscribed: false,
        };
        await tx.instagramAccount.upsert({
          where: { instagramId: profile.id },
          update: data,
          create: {
            ...data,
            workspaceId,
            instagramId: profile.id,
            provider: "META",
          },
        });
      }
    });
    for (const profile of profiles) {
      try {
        const result = await subscribeInstagramAccountToWebhooks(
          profile.id,
          serriniCredential(token.access_token, profile.id),
        );
        await prisma.instagramAccount.updateMany({
          where: {
            instagramId: profile.id,
            workspaceId,
            metaLoginMode: "UNIFIED",
          },
          data: { webhookSubscribed: result.success === true },
        });
      } catch {
        await prisma.operationalEvent.create({
          data: {
            workspaceId,
            source: "SYSTEM",
            level: "WARNING",
            message: `Serrini webhook subscription pending for @${profile.username}`,
          },
        });
      }
    }
    return finish("connected");
  } catch {
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId,
          source: "SYSTEM",
          level: "ERROR",
          message:
            "Serrini Unified Login connection failed. Reconnect after checking asset and scope access.",
        },
      })
      .catch(() => {});
    return finish("failed");
  }
}
