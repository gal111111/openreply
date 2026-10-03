import { prisma } from "@/lib/db/client";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";

function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function acceptPendingInvitationsForUser(
  userId: string,
  email?: string | null
): Promise<void> {
  if (!email) return;

  const normalizedEmail = normalizeInviteEmail(email);
  const now = new Date();
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: normalizedEmail,
      status: "PENDING",
      expiresAt: { gt: now },
    },
  });

  for (const invitation of invitations) {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
        update: {
          role: invitation.role,
        },
      }),
      prisma.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          status: "ACCEPTED",
          acceptedAt: now,
        },
      }),
    ]);
  }
}

export async function getWorkspaceMembership(userId: string): Promise<{
  workspace: Workspace;
  role: WorkspaceRole;
} | null> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return null;

  return {
    workspace: membership.workspace,
    role: membership.role,
  };
}

/**
 * True for a user who arrived through HobbyLand unified login (the account is
 * linked to that provider and the email was never confirmed by a magic link).
 * Such a user is invite-only: OpenReply never creates a workspace for them, so
 * they see nothing until a workspace owner or admin invites their address.
 */
export async function isInviteOnlyUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      emailVerified: true,
      accounts: {
        where: { provider: "hobbyland" },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!user) return true;
  return user.emailVerified === null && user.accounts.length > 0;
}

/**
 * Returns the user's workspace, accepting pending invitations first. A
 * self-sign-up user without one gets their own workspace; an invite-only user
 * (see isInviteOnlyUser) gets null instead.
 */
export async function ensureWorkspaceForUser(
  userId: string,
  email?: string | null
): Promise<Workspace | null> {
  await acceptPendingInvitationsForUser(userId, email);

  const existingMembership = await getWorkspaceMembership(userId);
  if (existingMembership) {
    return existingMembership.workspace;
  }

  if (await isInviteOnlyUser(userId)) {
    return null;
  }

  const workspaceName = email ? `${email.split("@")[0]}'s workspace` : "My workspace";

  return prisma.workspace.create({
    data: {
      name: workspaceName,
      ownerId: userId,
      members: {
        create: {
          userId,
          role: "OWNER",
        },
      },
    },
  });
}

export async function getPrimaryWorkspace(userId: string): Promise<Workspace | null> {
  const membership = await getWorkspaceMembership(userId);
  return membership?.workspace ?? null;
}
