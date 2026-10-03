import { z } from "zod";

// Shared by the session route (/api/automations) and the HobbyLand
// integration route (/api/integrations/v1/automations), so both create
// campaigns with the same validation and the same dependent-field rules.

export const createAutomationSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  })
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

/**
 * The scalar campaign fields for a new campaign, derived from validated input.
 * The caller adds workspaceId, instagramAccountId, reportShareSlug and links.
 */
export function buildAutomationCreateFields(data: CreateAutomationInput) {
  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    data.publicReplyMessages.length > 0
      ? data.publicReplyMessages
      : data.publicReplyMessage
        ? [data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    name: data.name,
    goal: data.goal,
    // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
    postId: isSpecificPost ? data.postId : null,
    postUrl: isSpecificPost ? data.postUrl : null,
    pendingNextReel,
    matchAnyPost,
    keywords: matchAnyWord ? [] : data.keywords,
    matchAnyWord,
    dmTriggerEnabled: data.dmTriggerEnabled,
    dmMessage: data.dmMessage,
    openingDmEnabled,
    openingDmMessage: openingDmEnabled
      ? data.openingDmMessage || null
      : null,
    openingDmButtonLabel: openingDmEnabled
      ? data.openingDmButtonLabel || null
      : null,
    linkButtonLabel: data.linkButtonLabel || null,
    requireFollow: data.requireFollow,
    followPromptMessage: data.requireFollow
      ? data.followPromptMessage || null
      : null,
    followPromptButtonLabel: data.requireFollow
      ? data.followPromptButtonLabel || null
      : null,
    followUpEnabled: data.followUpEnabled,
    followUpMessage: data.followUpEnabled
      ? data.followUpMessage || null
      : null,
    followUpDelayMinutes: data.followUpEnabled
      ? data.followUpDelayMinutes
      : 0,
    publicReplyEnabled: data.publicReplyEnabled,
    publicReplyMessages: data.publicReplyEnabled
      ? publicReplyList
      : [],
    publicReplyMessage: data.publicReplyEnabled
      ? publicReplyList[0] ?? data.publicReplyMessage ?? null
      : null,
    isActive: data.isActive,
    wholeWordMatch: data.wholeWordMatch,
  };
}
