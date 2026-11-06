import { prisma } from "@/lib/db/client";

export const HISTORY_EVENT = "Serrini resource history prepared v1";
export const SERRINI_IDS = new Set(["17841415718399486", "17841480865798985"]);
export type ResourceHistory = { postId: string; messageHash: string; key: string; campaignId: string; heldNames: string[]; heldIds: string[] };
export type HistoryPayload = { accountId: string; resources: ResourceHistory[]; preparedAt: string; identityVerified: true };

export function historyAllows(history: ResourceHistory | undefined, name?: string, id?: string) {
  if (!history) return false;
  // Missing author identity cannot establish recipient deduplication.
  if (!name || !id) return false;
  return !history.heldNames.includes(name.toLowerCase().replace(/^@/, "")) && !history.heldIds.includes(id);
}

export async function getResourceHistory(workspaceId: string, accountId: string, campaignId: string) {
  const event = await prisma.operationalEvent.findFirst({
    where: { workspaceId, message: HISTORY_EVENT, payload: { path: ["accountId"], equals: accountId } },
    orderBy: { createdAt: "desc" },
  });
  const payload = event?.payload as unknown as HistoryPayload | undefined;
  if (!payload?.identityVerified) return undefined;
  return payload.resources.find(r => r.campaignId === campaignId);
}
