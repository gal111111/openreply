import NextAuth, { type NextAuthConfig } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import {
  acceptPendingInvitationsForUser,
  ensureWorkspaceForUser,
  getPrimaryWorkspace,
} from "@/lib/workspace";
import { isEmailAllowedToSignIn } from "@/lib/env";
import {
  authorizeHobbylandSignIn,
  DEFAULT_SESSION_MAX_AGE_SECONDS,
  hobbylandProvider,
  limitHobbylandSession,
  withHobbylandSessionLimit,
  HOBBYLAND_PROVIDER_ID,
  type HobbylandProfile,
} from "@/lib/hobbyland-sso";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

const emailFrom = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";
// Setting EMAIL_SERVER switches magic links to your own SMTP server, for
// self-hosters who do not want a third-party mail service. Resend stays the
// default, so an existing deployment is unaffected.
const smtpServer = process.env.EMAIL_SERVER;

/**
 * Provider id the login form has to sign in with. It differs per transport,
 * so it is derived here rather than hardcoded at the call site.
 */
export const EMAIL_PROVIDER_ID = smtpServer ? "nodemailer" : "resend";

// HobbyLand unified login is only offered once its client id and secret are
// configured; see lib/hobbyland-sso.ts.
const hobbyland = hobbylandProvider();

export const authConfig = {
  // HobbyLand sessions are fixed at 8 hours and must not be rolled forward.
  adapter: withHobbylandSessionLimit(
    PrismaAdapter(prisma as unknown as AdapterPrismaClient)
  ),
  providers: [
    ...(hobbyland ? [hobbyland] : []),
    smtpServer
      ? Nodemailer({ server: smtpServer, from: emailFrom })
      : Resend({
          apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
          from: emailFrom,
        }),
  ],
  callbacks: {
    // Email: runs before the magic link is sent, so a blocked address never
    // receives one, and again when the link is verified.
    // HobbyLand: runs after the ID token is verified and before Auth.js links
    // or creates any user, so a refused identity never touches the database.
    async signIn({ user, account, profile }) {
      if (account?.provider === HOBBYLAND_PROVIDER_ID) {
        return authorizeHobbylandSignIn({
          account,
          profile: profile as HobbylandProfile | undefined,
        });
      }
      return isEmailAllowedToSignIn(user?.email);
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    // Sessions created through HobbyLand unified login last 8 hours; every
    // other sign-in method keeps the default session lifetime.
    async signIn({ user, account }) {
      if (account?.provider === HOBBYLAND_PROVIDER_ID) {
        await limitHobbylandSession(user?.id, {
          defaultMaxAgeSeconds: DEFAULT_SESSION_MAX_AGE_SECONDS,
        });
      }
    },
    async createUser({ user }) {
      if (!user.id) return;
      // Only an OAuth sign-up (HobbyLand) creates a user without a verified
      // email date. Such a user joins workspaces by invitation only and never
      // gets a workspace of their own.
      const { emailVerified } = user as { emailVerified?: Date | null };
      if (!emailVerified) {
        await acceptPendingInvitationsForUser(user.id, user.email);
        return;
      }
      await ensureWorkspaceForUser(user.id, user.email);
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
    maxAge: DEFAULT_SESSION_MAX_AGE_SECONDS,
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace?.id ?? null;
}
