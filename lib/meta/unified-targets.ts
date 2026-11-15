import { Buffer } from "node:buffer";
import { z } from "zod";

const foundrRequiredScopes = Object.freeze([
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "instagram_manage_insights",
] as const);

export const FOUNDR_UNIFIED_TARGET = Object.freeze({
  key: "foundr",
  displayName: "Foundr",
  contentCenterProfileId: 13,
  username: "kingofhkai",
  appId: "1574251267790326",
  configId: "1133446066003520",
  statePrefix: "foundr-unified:",
  stateCookie: "foundr_instagram_oauth",
  requiredScopes: foundrRequiredScopes,
} as const);

export const TALENT_UNIFIED_TARGET = Object.freeze({
  key: "talent",
  displayName: "HK AI Talents",
  contentCenterProfileId: 9,
  username: "aieverydayyyyy",
  instagramId: "17841453286100150",
  openReplyAccountId: "cmw0fvqyl00010dptynpxm95p",
  workspaceId: "cmutbjo0l00010dl18clrgsap",
  replyOwner: "openreply",
  appId: "1574251267790326",
  configId: "1133446066003520",
  statePrefix: "talent-unified:",
  stateCookie: "talent_instagram_oauth",
  requiredScopes: Object.freeze([
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_comments",
    "instagram_manage_messages",
  ] as const),
} as const);

const unifiedTargets = Object.freeze({
  foundr: FOUNDR_UNIFIED_TARGET,
  talent: TALENT_UNIFIED_TARGET,
});

export const unifiedTargetStateSchema = z.object({
  targetKey: z.enum(["foundr", "talent"]),
  contentCenterProfileId: z.number().int(),
  workspaceId: z.string().trim().min(1),
  username: z.string().toLowerCase(),
  appId: z.literal(FOUNDR_UNIFIED_TARGET.appId),
  configId: z.literal(FOUNDR_UNIFIED_TARGET.configId),
}).strict().refine((state) => {
  const target = getUnifiedTarget(state.targetKey);
  return state.contentCenterProfileId === target.contentCenterProfileId &&
    state.username === target.username &&
    (target.key !== "talent" || state.workspaceId === target.workspaceId);
});

export type UnifiedTargetState = z.infer<typeof unifiedTargetStateSchema>;

const assignedAccountSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
  username: z.string().min(1),
});

export function getUnifiedTarget(key: unknown) {
  if (key !== "foundr" && key !== "talent") {
    throw new Error("Unsupported Unified Login target");
  }
  return unifiedTargets[key];
}

// Carry this value through the existing signed OAuth state and cookie checks.
export function createUnifiedTargetState(key: unknown, workspaceId: string): string {
  const target = getUnifiedTarget(key);
  const result = unifiedTargetStateSchema.safeParse({
    targetKey: target.key,
    contentCenterProfileId: target.contentCenterProfileId,
    workspaceId,
    username: target.username,
    appId: target.appId,
    configId: target.configId,
  });
  if (!result.success) {
    throw new Error("Invalid Unified Login target state");
  }
  const payload = Buffer.from(JSON.stringify(result.data)).toString("base64url");
  return target.statePrefix + payload;
}

// Call after verifyOAuthState has checked the signed envelope and its age.
export function parseUnifiedTargetState(value: unknown): UnifiedTargetState {
  if (typeof value !== "string") {
    throw new Error("Invalid Unified Login target state");
  }
  const target = Object.values(unifiedTargets).find((candidate) =>
    value.startsWith(candidate.statePrefix),
  );
  if (!target) {
    throw new Error("Invalid Unified Login target state");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(value.slice(target.statePrefix.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("Invalid Unified Login target state");
  }

  const result = unifiedTargetStateSchema.safeParse(payload);
  if (!result.success || result.data.targetKey !== target.key) {
    throw new Error("Invalid Unified Login target state");
  }
  return result.data;
}

export function selectUnifiedTargetAccount(
  key: unknown,
  assignedAccounts: unknown,
  previousInstagramId?: string,
): { id: string; username: ReturnType<typeof getUnifiedTarget>["username"] } {
  const target = getUnifiedTarget(key);
  const result = z.array(assignedAccountSchema).safeParse(assignedAccounts);
  if (!result.success) {
    throw new Error("Invalid assigned Instagram accounts");
  }

  const matchingAccounts = result.data.filter(
    (account) => account.username.toLowerCase() === target.username,
  );
  const accountsById = new Map(
    matchingAccounts.map((account) => [account.id, account] as const),
  );
  if (accountsById.size !== 1) {
    throw new Error("Unified Login target account is missing or ambiguous");
  }

  const account = accountsById.values().next().value!;
  if (target.key === "talent" && account.id !== target.instagramId) {
    throw new Error("Unified Login target account binding changed");
  }
  if (previousInstagramId !== undefined && account.id !== previousInstagramId) {
    throw new Error("Unified Login target account binding changed");
  }
  return { id: account.id, username: target.username };
}
