import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  buildAutomationCreateFields,
  createAutomationSchema,
} from "@/lib/campaigns/automation-input";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { getBaseUrl } from "@/lib/env";
import { resolveInstagramPostId } from "@/lib/integrations/resolve-post";
import {
  resolveInstagramAccount,
  resolveWorkspace,
} from "@/lib/integrations/resolve-target";
import {
  serviceKeyErrorResponse,
  verifyServiceKey,
} from "@/lib/integrations/service-key";
import { generateReportShareSlug } from "@/lib/reports/share";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { instagramShortcode } from "@/lib/utils/csv";

// HobbyLand integration spec v1, section 1: the Hub creates a comment-keyword
// DM campaign after it publishes a post. Idempotent by external_id.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const bodySchema = z.object({
  external_id: z.string().trim().min(1).max(200),
  workspace: z.string().trim().min(1).optional().nullable(),
  instagram_account: z.string().trim().min(1),
  post_url: z.string().url(),
  // Optional: the media id, when the caller already knows it. Skips the lookup.
  post_id: z.string().trim().min(1).optional().nullable(),
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  dm_message: z.string().trim().min(1).max(1000),
  // Omitted leaves an existing link as it is; null or "" removes it.
  link_url: z.union([z.string().url(), z.literal("")]).optional().nullable(),
  active: z.boolean().optional().default(true),
  name: z.string().trim().min(1).max(100).optional().nullable(),
  source: z
    .object({
      system: z.string().trim().max(50).optional().nullable(),
      production_id: z.string().trim().max(200).optional().nullable(),
    })
    .passthrough()
    .optional()
    .nullable(),
});

function jsonError(error: string, status: number, details?: unknown) {
  return NextResponse.json(
    details === undefined ? { error } : { error, details },
    { status, headers: NO_STORE }
  );
}

function campaignUrl(id: string) {
  return `${getBaseUrl().replace(/\/$/, "")}/campaigns/${id}`;
}

async function writeAudit(entry: {
  workspaceId: string;
  caller: string;
  action: "created" | "updated";
  automationId: string;
  externalId: string;
}) {
  const verb = entry.action === "created" ? "建立" : "更新";
  const message = `系統互通：${entry.caller} ${verb}了自動私訊（${entry.externalId}）`;
  console.info(`[integrations] ${message} automation=${entry.automationId}`);
  try {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: entry.workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message,
        payload: {
          integration: "hobbyland-v1",
          caller: entry.caller,
          action: entry.action,
          automationId: entry.automationId,
          externalId: entry.externalId,
        },
      },
    });
  } catch (error) {
    // The write itself succeeded; a missing audit row must not turn it into a
    // failure the caller would retry.
    console.error("[integrations] 無法寫入審計記錄", error);
  }
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export async function POST(request: NextRequest) {
  const auth = await verifyServiceKey(
    request.headers.get("authorization"),
    "automations:write"
  );
  if (!auth.ok) return serviceKeyErrorResponse(auth);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("請求內容不是有效的 JSON。", 400);
  }
  const parsedBody = bodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return jsonError("請求內容不正確。", 400, parsedBody.error.flatten());
  }
  const body = parsedBody.data;

  const workspace = await resolveWorkspace(body.workspace);
  if (!workspace.ok) return jsonError(workspace.error, workspace.status);
  const workspaceId = workspace.value.id;

  const account = await resolveInstagramAccount(
    workspaceId,
    body.instagram_account
  );
  if (!account) {
    return jsonError(
      `工作區內找不到 Instagram 帳號「${body.instagram_account}」。`,
      404
    );
  }

  const existing = await prisma.automation.findUnique({
    where: { externalId: body.external_id },
    select: { id: true, workspaceId: true, postId: true, postUrl: true },
  });
  if (existing && existing.workspaceId !== workspaceId) {
    return jsonError("此 external_id 已屬於另一個工作區，無法更新。", 409);
  }

  // Resolve the media id the comment matcher needs. A resend for the same
  // post reuses the stored id rather than calling Instagram again.
  let postId = body.post_id ?? null;
  let postUrl = body.post_url;
  if (!postId) {
    const shortcode = instagramShortcode(body.post_url);
    if (!shortcode) {
      return jsonError("post_url 不是有效的 Instagram 貼文網址。", 422);
    }
    if (
      existing?.postId &&
      existing.postUrl &&
      instagramShortcode(existing.postUrl) === shortcode
    ) {
      postId = existing.postId;
    } else {
      const resolved = await resolveInstagramPostId(account, body.post_url);
      if (!resolved.ok) {
        if (resolved.reason === "lookup_failed") {
          console.error(
            `[integrations] 讀取 Instagram 貼文失敗 account=${account.id}: ${resolved.detail ?? ""}`
          );
          return jsonError(
            "暫時無法向 Instagram 查詢該貼文，請稍後重試。",
            502
          );
        }
        if (resolved.reason === "invalid_url") {
          return jsonError("post_url 不是有效的 Instagram 貼文網址。", 422);
        }
        return jsonError(
          "在該 Instagram 帳號最近的貼文中找不到 post_url 指向的貼文。",
          422
        );
      }
      postId = resolved.postId;
      postUrl = resolved.postUrl;
    }
  }

  const linkUrl =
    body.link_url === undefined ? undefined : (body.link_url ?? "");
  const sourceSystem = body.source?.system?.trim() || auth.caller;
  const sourceRef = body.source?.production_id?.trim() || null;
  const defaultName = `${sourceSystem}：${sourceRef ?? body.keywords.join("、")}`.slice(0, 100);

  // Same validation and field rules as campaigns created in the dashboard.
  const parsed = createAutomationSchema.safeParse({
    name: body.name ?? defaultName,
    instagramAccountId: account.id,
    postId,
    postUrl,
    keywords: body.keywords,
    dmMessage: body.dm_message,
    trackedDestinationUrl: linkUrl,
    isActive: body.active,
  });
  if (!parsed.success) {
    return jsonError("請求內容不正確。", 400, parsed.error.flatten());
  }
  const fields = buildAutomationCreateFields(parsed.data);

  const update = async (automationId: string) =>
    prisma.$transaction(async (tx) => {
      const campaign = await tx.automation.update({
        where: { id: automationId },
        // Only the fields the caller owns. Settings changed in the dashboard
        // (public reply, follow gate, follow-up, name) are kept.
        data: {
          ...(body.name ? { name: fields.name } : {}),
          instagramAccountId: account.id,
          postId: fields.postId,
          postUrl: fields.postUrl,
          pendingNextReel: false,
          matchAnyPost: false,
          matchAnyWord: false,
          keywords: fields.keywords,
          dmMessage: fields.dmMessage,
          isActive: fields.isActive,
          sourceSystem,
          sourceRef,
        },
        select: { id: true },
      });
      await syncCampaignLinks(tx, {
        workspaceId,
        automationId,
        primaryUrl: linkUrl,
      });
      return campaign;
    });

  let automationId: string;
  let action: "created" | "updated";

  if (existing) {
    automationId = (await update(existing.id)).id;
    action = "updated";
  } else {
    try {
      const linkCreates = buildInitialCampaignLinks({
        workspaceId,
        primaryUrl: linkUrl,
      });
      const created = await prisma.automation.create({
        data: {
          ...fields,
          externalId: body.external_id,
          sourceSystem,
          sourceRef,
          workspaceId,
          instagramAccountId: account.id,
          reportShareSlug: generateReportShareSlug(),
          ...(linkCreates.length > 0
            ? { trackedLinks: { create: linkCreates } }
            : {}),
        },
        select: { id: true },
      });
      automationId = created.id;
      action = "created";
    } catch (error) {
      // Two concurrent sends of the same external_id: the loser updates.
      if (!isUniqueViolation(error)) throw error;
      const winner = await prisma.automation.findUnique({
        where: { externalId: body.external_id },
        select: { id: true, workspaceId: true },
      });
      if (!winner || winner.workspaceId !== workspaceId) throw error;
      automationId = (await update(winner.id)).id;
      action = "updated";
    }
  }

  await writeAudit({
    workspaceId,
    caller: auth.caller,
    action,
    automationId,
    externalId: body.external_id,
  });

  return NextResponse.json(
    {
      id: automationId,
      external_id: body.external_id,
      status: action,
      url: campaignUrl(automationId),
    },
    { status: action === "created" ? 201 : 200, headers: NO_STORE }
  );
}

export async function GET(request: NextRequest) {
  const auth = await verifyServiceKey(
    request.headers.get("authorization"),
    "automations:read"
  );
  if (!auth.ok) return serviceKeyErrorResponse(auth);

  const externalId = request.nextUrl.searchParams.get("external_id")?.trim();
  if (!externalId) return jsonError("缺少 external_id 參數。", 400);

  const automation = await prisma.automation.findUnique({
    where: { externalId },
    select: {
      id: true,
      externalId: true,
      workspaceId: true,
      instagramAccountId: true,
      postId: true,
      postUrl: true,
      keywords: true,
      dmMessage: true,
      isActive: true,
      sourceSystem: true,
      sourceRef: true,
      createdAt: true,
      updatedAt: true,
      instagramAccount: { select: { username: true } },
      trackedLinks: {
        select: { destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
        take: 1,
      },
      _count: { select: { dmLogs: true } },
    },
  });
  if (!automation) {
    return jsonError("找不到此 external_id 的自動私訊。", 404);
  }

  return NextResponse.json(
    {
      id: automation.id,
      external_id: automation.externalId,
      status: automation.isActive ? "active" : "inactive",
      active: automation.isActive,
      workspace: automation.workspaceId,
      instagram_account: automation.instagramAccount.username,
      instagram_account_id: automation.instagramAccountId,
      post_url: automation.postUrl,
      post_id: automation.postId,
      keywords: automation.keywords,
      dm_message: automation.dmMessage,
      link_url: automation.trackedLinks[0]?.destinationUrl ?? null,
      dm_count: automation._count.dmLogs,
      source: { system: automation.sourceSystem, ref: automation.sourceRef },
      url: campaignUrl(automation.id),
      created_at: automation.createdAt.toISOString(),
      updated_at: automation.updatedAt.toISOString(),
    },
    { headers: NO_STORE }
  );
}
