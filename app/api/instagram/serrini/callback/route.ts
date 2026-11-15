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
  serriniFailureDiagnostic,
} from "@/lib/meta/serrini-unified";
import {
  FOUNDR_UNIFIED_TARGET,
  getUnifiedTarget,
  parseUnifiedTargetState,
  selectUnifiedTargetAccount,
} from "@/lib/meta/unified-targets";
import { createUnifiedConnectionReceipt } from "@/lib/integrations/unified-connection-handoff";

export async function GET(request: NextRequest) {
  const base = getBaseUrl();
  let stateCookie: string = SERRINI_STATE_COOKIE;
  function finish(result: string) {
    const response = NextResponse.redirect(
      `${base}/settings?serrini=${result}`,
    );
    response.cookies.set(stateCookie, "", {
      path: "/api/instagram/serrini",
      maxAge: 0,
    });
    return response;
  }
  const raw = request.nextUrl.searchParams.get("state");
  const state = verifyOAuthState(raw);
  if (
    !state ||
    typeof state.workspaceId !== "string" ||
    !Number.isFinite(state.ts) ||
    state.ts > Date.now()
  ) return finish("invalid");
  let target: ReturnType<typeof getUnifiedTarget> | null = null;
  let workspaceId: string;
  if (state.workspaceId.startsWith(SERRINI_STATE_PREFIX)) {
    workspaceId = state.workspaceId.slice(SERRINI_STATE_PREFIX.length);
    if (!workspaceId) return finish("invalid");
  } else {
    if (state.workspaceId.startsWith(FOUNDR_UNIFIED_TARGET.statePrefix)) {
      stateCookie = FOUNDR_UNIFIED_TARGET.stateCookie;
    }
    try {
      const targetState = parseUnifiedTargetState(state.workspaceId);
      target = getUnifiedTarget(targetState.targetKey);
      workspaceId = targetState.workspaceId;
    } catch {
      return finish("invalid");
    }
  }
  const cookie = request.cookies.get(stateCookie)?.value;
  if (
    !raw ||
    !cookie ||
    Buffer.byteLength(raw) !== Buffer.byteLength(cookie) ||
    !timingSafeEqual(Buffer.from(raw), Buffer.from(cookie))
  )
    return finish("invalid");
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
  let stage = "token_exchange";
  try {
    const token = await exchangeSerriniCode(code, `${base}/api/instagram/serrini/callback`, target?.key);
    stage = "asset_verification";
    const assets = target
      ? await getSerriniAssets(token.access_token, target.key)
      : await getSerriniAssets(token.access_token);
    stage = "profile_verification";
    const profiles = await Promise.all(
      assets.accounts.map(async (account) => {
        const profile = await getUserInfo(
          serriniCredential(token.access_token, account.id),
        );
        const username = profile.username.toLowerCase();
        const approvedHandle = target
          ? username === target.username
          : SERRINI_HANDLES.has(username);
        if (
          profile.id !== account.id ||
          !approvedHandle ||
          username !== account.username.toLowerCase()
        ) {
          throw new Error(
            "Instagram account identity does not match the assigned asset",
          );
        }
        return profile;
      }),
    );
    const encryptedToken = encryptToken(token.access_token);
    stage = "account_persistence";
    // All selected accounts commit together. A conflicting existing owner aborts
    // the transaction before either account receives a new credential.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('serrini-unified-connect'))`;
      if (target) {
        const previousAccounts = await tx.instagramAccount.findMany({
          where: { username: { equals: target.username, mode: "insensitive" } },
          select: { instagramId: true, workspaceId: true },
        });
        for (const previous of previousAccounts) {
          if (previous.workspaceId !== workspaceId) {
            throw new Error("An Instagram account is already bound to another connection");
          }
          selectUnifiedTargetAccount(target.key, assets.accounts, previous.instagramId);
        }
      }
      for (const profile of profiles) {
        const existing = await tx.instagramAccount.findUnique({
          where: { instagramId: profile.id },
        });
        if (
          existing &&
          (existing.workspaceId !== workspaceId ||
            existing.provider !== "META" ||
            (existing.metaAppId &&
              existing.metaAppId !== requireEnv("SERRINI_META_APP_ID")) ||
            (target && existing.metaConfigId && existing.metaConfigId !== target.configId))
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
        const savedAccount = await tx.instagramAccount.upsert({
          where: { instagramId: profile.id },
          update: data,
          create: {
            ...data,
            workspaceId,
            instagramId: profile.id,
            provider: "META",
          },
        });
        if (target) {
          const receipt = createUnifiedConnectionReceipt({
            targetKey: target.key,
            contentCenterProfileId: target.contentCenterProfileId,
            workspaceId,
            username: target.username,
            appId: target.appId,
            configId: target.configId,
            platform: "instagram",
            openReplyAccountId: savedAccount.id,
            instagramId: profile.id,
            clientBusinessId: assets.businessId,
            loginMode: "UNIFIED",
            expiration: assets.expiresAt
              ? { kind: "expires_at", expiresAt: assets.expiresAt.toISOString() }
              : { kind: "never" },
            scopes: assets.scopes,
            verifiedAt: new Date().toISOString(),
            accessToken: token.access_token,
          }, workspaceId);
          await tx.operationalEvent.create({
            data: {
              workspaceId,
              source: "SYSTEM",
              level: "INFO",
              message: "Foundr Instagram connection verified. Content Center handoff pending.",
              payload: { ...receipt, contentCenterHandoff: "pending" },
            },
          });
        }
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
            message: `${target ? "Foundr" : "Serrini"} webhook subscription pending for @${profile.username}`,
          },
        }).catch(() => {});
      }
    }
    await prisma.operationalEvent.create({ data: {
      workspaceId, source: "SYSTEM", level: "INFO",
      message: `${target ? "Foundr" : "Serrini"} connection verified [${assets.verificationMethod};accounts_${profiles.length}].`,
    } }).catch(() => {});
    return finish("connected");
  } catch (error) {
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId,
          source: "SYSTEM",
          level: "ERROR",
          message:
            `${target ? "Foundr" : "Serrini"} Unified Login connection failed [${stage};${serriniFailureDiagnostic(error)}].`,
        },
      })
      .catch(() => {});
    return finish("failed");
  }
}
