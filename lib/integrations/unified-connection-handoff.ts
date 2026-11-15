import { createHash } from "node:crypto";
import { z } from "zod";
import {
  getUnifiedTarget,
  unifiedTargetStateSchema,
} from "@/lib/meta/unified-targets";

const expirationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }).strict(),
  z.object({
    kind: z.literal("expires_at"),
    expiresAt: z.iso.datetime({ offset: true }),
  }).strict(),
]);

const handoffSchema = unifiedTargetStateSchema.extend({
  platform: z.literal("instagram"),
  openReplyAccountId: z.string().trim().min(1),
  instagramId: z.string().regex(/^[1-9]\d*$/),
  clientBusinessId: z.string().regex(/^[1-9]\d*$/),
  loginMode: z.literal("UNIFIED"),
  expiration: expirationSchema,
  scopes: z.array(z.string()).transform((scopes) => [...new Set(scopes)].sort()),
  verifiedAt: z.iso.datetime({ offset: true }),
  accessToken: z.string().min(1).refine((token) => /\S/.test(token)),
}).strict();

export type UnifiedConnectionHandoff = z.infer<typeof handoffSchema>;
export type UnifiedTokenExpiration = z.infer<typeof expirationSchema>;
export type UnifiedConnectionReceipt = Omit<UnifiedConnectionHandoff, "accessToken"> & {
  connectionVersion: string;
};

export function createUnifiedTokenExpiration(value: unknown): UnifiedTokenExpiration {
  const result = z.number().int().nonnegative().safeParse(value);
  if (!result.success) {
    throw new Error("Invalid Unified Login token expiration");
  }
  if (result.data === 0) {
    return { kind: "never" };
  }

  const expiresAt = new Date(result.data * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Invalid Unified Login token expiration");
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error("Unified Login token has expired");
  }
  return { kind: "expires_at", expiresAt: expiresAt.toISOString() };
}

// Use in authenticated server-to-server handlers after Meta asset verification.
// Bind expectedWorkspaceId to the authenticated integration's workspace.
export function parseUnifiedConnectionHandoff(
  value: unknown,
  expectedWorkspaceId: string,
): UnifiedConnectionHandoff {
  const result = handoffSchema.safeParse(value);
  if (!result.success || result.data.workspaceId !== expectedWorkspaceId) {
    throw new Error("Invalid Unified Login connection handoff");
  }

  const handoff = result.data;
  const target = getUnifiedTarget(handoff.targetKey);
  if (!target.requiredScopes.every((scope) => handoff.scopes.includes(scope))) {
    throw new Error("Unified Login connection permissions are incomplete");
  }
  if (
    handoff.expiration.kind === "expires_at" &&
    Date.parse(handoff.expiration.expiresAt) <= Date.now()
  ) {
    throw new Error("Unified Login connection has expired");
  }
  return handoff;
}

// Use this explicit receipt for browser responses and operational logs.
export function createUnifiedConnectionReceipt(
  value: unknown,
  expectedWorkspaceId: string,
): UnifiedConnectionReceipt {
  const handoff = parseUnifiedConnectionHandoff(value, expectedWorkspaceId);
  const { accessToken, ...metadata } = handoff;
  const versionParts = [
    metadata.targetKey,
    metadata.contentCenterProfileId,
    metadata.workspaceId,
    metadata.openReplyAccountId,
    metadata.instagramId,
    metadata.username,
    metadata.appId,
    metadata.configId,
    metadata.clientBusinessId,
    metadata.loginMode,
    metadata.expiration,
    metadata.scopes,
    accessToken,
  ];
  const connectionVersion = createHash("sha256")
    .update(JSON.stringify(versionParts))
    .digest("hex");
  return { ...metadata, connectionVersion };
}
