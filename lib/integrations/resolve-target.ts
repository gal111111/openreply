import { prisma } from "@/lib/db/client";

type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; status: 404 | 422; error: string };

/**
 * Find the target workspace by id, or by its name (Workspace has no slug
 * column). Falls back to OPENREPLY_DEFAULT_WORKSPACE when none is given.
 */
export async function resolveWorkspace(
  ref: string | null | undefined
): Promise<Resolved<{ id: string; name: string }>> {
  const wanted = ref?.trim() || process.env.OPENREPLY_DEFAULT_WORKSPACE?.trim();
  if (!wanted) {
    return {
      ok: false,
      status: 422,
      error: "未提供 workspace，且本系統未設定 OPENREPLY_DEFAULT_WORKSPACE。",
    };
  }

  const byId = await prisma.workspace.findUnique({
    where: { id: wanted },
    select: { id: true, name: true },
  });
  if (byId) return { ok: true, value: byId };

  const byName = await prisma.workspace.findMany({
    where: { name: { equals: wanted, mode: "insensitive" } },
    select: { id: true, name: true },
    take: 2,
  });
  if (byName.length > 1) {
    return {
      ok: false,
      status: 422,
      error: `有多個工作區名為「${wanted}」，請改用工作區 id。`,
    };
  }
  if (byName.length === 1) return { ok: true, value: byName[0] };

  return { ok: false, status: 404, error: `找不到工作區「${wanted}」。` };
}

/** Find an Instagram account in the workspace by its id or username. */
export async function resolveInstagramAccount(workspaceId: string, ref: string) {
  const wanted = ref.trim().replace(/^@/, "");
  return prisma.instagramAccount.findFirst({
    where: {
      workspaceId,
      OR: [
        { id: wanted },
        { username: { equals: wanted, mode: "insensitive" } },
      ],
    },
    orderBy: { connectedAt: "desc" },
  });
}
