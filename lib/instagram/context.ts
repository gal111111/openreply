import { decryptToken } from "@/lib/meta/oauth";
import type { MetaCredential } from "@/lib/meta/credentials";
import { prisma } from "@/lib/db/client";

export type InstagramContext =
  | { provider: "META"; accessToken: MetaCredential }
  | {
      provider: "ZERNIO";
      apiKey: string;
      accountId: string;
      instagramId: string;
      operationId?: string;
    };

export type ProviderAccount = {
  provider: "META" | "ZERNIO";
  workspaceId: string;
  zernioAccountId: string | null;
  instagramId: string;
  accessToken: string;
  metaLoginMode?: string;
  metaAppId?: string | null;
};

export function hasInstagramCredentials(
  account: Pick<ProviderAccount, "provider" | "accessToken" | "zernioAccountId">
) {
  return account.provider === "ZERNIO"
    ? Boolean(account.zernioAccountId)
    : Boolean(account.accessToken);
}

export async function createInstagramContext(
  account: ProviderAccount,
  operationId?: string
): Promise<InstagramContext> {
  if (account.provider !== "ZERNIO") {
    const token = decryptToken(account.accessToken);
    if (account.metaLoginMode === "UNIFIED") {
      if (account.metaAppId !== process.env.SERRINI_META_APP_ID) {
        throw new Error("Unified Instagram app binding is unavailable");
      }
      return { provider: "META", accessToken: {
        accessToken: token, instagramId: account.instagramId, loginMode: "UNIFIED",
      } };
    }
    return { provider: "META", accessToken: token };
  }
  if (!account.zernioAccountId)
    throw new Error("Zernio account is not connected");
  const connection = await prisma.zernioConnection.findUnique({
    where: { workspaceId: account.workspaceId },
    select: { apiKey: true },
  });
  if (!connection) throw new Error("Zernio workspace connection is missing");
  return {
    provider: "ZERNIO",
    apiKey: decryptToken(connection.apiKey),
    accountId: account.zernioAccountId,
    instagramId: account.instagramId,
    ...(operationId ? { operationId } : {}),
  };
}

export type ZernioContext = Extract<InstagramContext, { provider: "ZERNIO" }>;
