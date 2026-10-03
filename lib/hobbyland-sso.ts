import type { Account, Profile } from "next-auth";
import type { Adapter, AdapterSession } from "next-auth/adapters";
import type { OIDCConfig } from "next-auth/providers";
import { prisma } from "@/lib/db/client";
import { isEmailAllowedToSignIn } from "@/lib/env";

/**
 * HobbyLand unified login (OIDC).
 *
 * The central identity service (https://auth.hobbyland-group.com) issues
 * RS256 ID tokens carrying only sub / email / email_verified. It decides which
 * staff may use which client; OpenReply still decides, locally, which of those
 * people may sign in here and what they can see (workspace roles stay local).
 *
 * Everything is off until the client id and secret are set, so an existing
 * deployment keeps magic-link sign-in only.
 */

export const HOBBYLAND_PROVIDER_ID = "hobbyland";
export const DEFAULT_HOBBYLAND_ISSUER = "https://auth.hobbyland-group.com";
const MIN_CLIENT_SECRET_LENGTH = 32;
/** Fixed label: HobbyLand staff see the same button text in every app. */
export const HOBBYLAND_SIGN_IN_LABEL = "使用 HobbyLand 統一登入";

type HobbylandSsoSettings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
};

function readIssuer(): string | null {
  const raw = process.env.HOBBYLAND_SSO_ISSUER?.trim() || DEFAULT_HOBBYLAND_ISSUER;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Null unless every required setting is present and well formed. */
export function getHobbylandSsoSettings(): HobbylandSsoSettings | null {
  const clientId = process.env.HOBBYLAND_SSO_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.HOBBYLAND_SSO_CLIENT_SECRET ?? "";
  const issuer = readIssuer();
  if (!clientId || clientSecret.length < MIN_CLIENT_SECRET_LENGTH || !issuer) {
    return null;
  }
  return { issuer, clientId, clientSecret };
}

export function isHobbylandSsoConfigured(): boolean {
  return getHobbylandSsoSettings() !== null;
}

export type HobbylandProfile = Profile & {
  sub?: string;
  email?: string | null;
  email_verified?: boolean;
};

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * The Auth.js provider, or null when SSO is not configured.
 *
 * allowDangerousEmailAccountLinking is on so an existing OpenReply user (who
 * signed up by magic link) can sign in with the same address through
 * HobbyLand without first being signed in. It is only safe together with
 * authorizeHobbylandSignIn below, which rejects the sign-in before Auth.js
 * links anything unless email_verified is true. HobbyLand only sets that
 * claim after an administrator has verified the employee's address, so the
 * link is as strong as the magic-link proof of mailbox ownership.
 */
export function hobbylandProvider(): OIDCConfig<HobbylandProfile> | null {
  const settings = getHobbylandSsoSettings();
  if (!settings) return null;

  return {
    id: HOBBYLAND_PROVIDER_ID,
    name: "HobbyLand",
    type: "oidc",
    issuer: settings.issuer,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    checks: ["pkce", "state", "nonce"],
    client: {
      token_endpoint_auth_method: "client_secret_basic",
      id_token_signed_response_alg: "RS256",
    },
    authorization: { params: { scope: "openid email" } },
    allowDangerousEmailAccountLinking: true,
    // Lower-case the address so Auth.js links to the same row the magic-link
    // provider created (it stores addresses lower-cased).
    profile(profile) {
      return {
        id: String(profile.sub ?? ""),
        email: normalizeEmail(profile.email),
        name: null,
        image: null,
      };
    },
    // Tokens are short-lived and OpenReply never calls HobbyLand APIs, so
    // nothing from the token response is stored in the Account row.
    account() {
      return {};
    },
  };
}

/** Emails and subjects listed in HOBBYLAND_SSO_ALLOWED (a JSON array). */
export function readHobbylandAllowedList(): Set<string> {
  const raw = process.env.HOBBYLAND_SSO_ALLOWED;
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => (entry.includes("@") ? entry.toLowerCase() : entry))
    );
  } catch {
    // A malformed list grants nobody anything extra.
    return new Set();
  }
}

export type HobbylandSignInLookups = {
  userExistsByEmail(email: string): Promise<boolean>;
  accountLinked(provider: string, providerAccountId: string): Promise<boolean>;
};

const prismaLookups: HobbylandSignInLookups = {
  async userExistsByEmail(email) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    return Boolean(user);
  },
  async accountLinked(provider, providerAccountId) {
    const account = await prisma.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: { id: true },
    });
    return Boolean(account);
  },
};

/**
 * Decides whether a HobbyLand identity may sign in to OpenReply.
 *
 * Allowed only when the identity service vouches for the email
 * (email_verified === true) and one of:
 *  - this HobbyLand subject is already linked to an OpenReply user,
 *  - an OpenReply user with that email already exists, or
 *  - the email or subject is listed in HOBBYLAND_SSO_ALLOWED.
 * ALLOWED_EMAILS, when set, still applies on top, as for every sign-in path.
 */
export async function authorizeHobbylandSignIn(
  input: { account: Account | null | undefined; profile: HobbylandProfile | undefined },
  lookups: HobbylandSignInLookups = prismaLookups
): Promise<boolean> {
  const { account, profile } = input;
  if (!account || account.provider !== HOBBYLAND_PROVIDER_ID || !profile) return false;

  const subject = typeof profile.sub === "string" ? profile.sub : "";
  if (!subject || account.providerAccountId !== subject) return false;

  const email = normalizeEmail(profile.email);
  if (!email || profile.email_verified !== true) return false;
  if (!isEmailAllowedToSignIn(email)) return false;

  const allowed = readHobbylandAllowedList();
  if (allowed.has(email) || allowed.has(subject)) return true;

  if (await lookups.accountLinked(HOBBYLAND_PROVIDER_ID, subject)) return true;
  return lookups.userExistsByEmail(email);
}

/* ------------------------------------------------------------------------ */
/* Session lifetime                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Sessions created through HobbyLand unified login last 8 hours from sign-in,
 * the same as the central identity session (user decision, 2026-10-03), and
 * are never extended. Magic-link sessions keep the default 30-day rolling
 * lifetime.
 */
export const HOBBYLAND_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
/** Auth.js default, stated explicitly so the lookup window below matches it. */
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Slack between Auth.js creating the session and events.signIn running. */
const NEW_SESSION_WINDOW_MS = 2 * 60 * 1000;

type SessionRow = {
  sessionToken: string;
  userId: string;
  expires: Date;
  authProvider?: string | null;
};

export type HobbylandSessionStore = {
  session: {
    updateMany(args: {
      where: {
        userId: string;
        authProvider: null;
        expires: { gte: Date };
      };
      data: { expires: Date; authProvider: string };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { sessionToken: string };
    }): Promise<SessionRow | null>;
  };
};

/**
 * Runs from events.signIn after a HobbyLand sign-in. Auth.js has just created
 * the database session with the default 30-day expiry and gives no hook to
 * choose it per provider, so the session is found here (this user's session
 * whose expiry is still within two minutes of a full 30 days, i.e. created
 * moments ago) and cut to 8 hours. In the rare case the same user also
 * finished a magic-link sign-in in another browser within those two minutes,
 * that session is shortened too, which errs on the safe side.
 *
 * When the user was already signed in, Auth.js reuses the existing session
 * and creates none; nothing matches and that session keeps its lifetime.
 */
export async function limitHobbylandSession(
  userId: string | undefined,
  options: { now?: Date; defaultMaxAgeSeconds?: number } = {},
  store: HobbylandSessionStore = prisma as unknown as HobbylandSessionStore
): Promise<number> {
  if (!userId) return 0;
  const now = options.now ?? new Date();
  const defaultMaxAge = options.defaultMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS;
  const newSessionFloor = new Date(
    now.getTime() + defaultMaxAge * 1000 - NEW_SESSION_WINDOW_MS
  );
  const { count } = await store.session.updateMany({
    where: { userId, authProvider: null, expires: { gte: newSessionFloor } },
    data: {
      expires: new Date(now.getTime() + HOBBYLAND_SESSION_MAX_AGE_SECONDS * 1000),
      authProvider: HOBBYLAND_PROVIDER_ID,
    },
  });
  if (count === 0) {
    console.warn("[hobbyland-sso] 找不到剛建立的統一登入 session，未能設定 8 小時時限。");
  }
  return count;
}

/**
 * Wraps the Prisma adapter so a HobbyLand session is never extended. Auth.js
 * asks to roll the expiry forward once a session is older than updateAge;
 * for an 8-hour session that is on every request, so the stored row is
 * returned unchanged instead. Other sessions are passed through untouched.
 */
export function withHobbylandSessionLimit(
  adapter: Adapter,
  store: HobbylandSessionStore = prisma as unknown as HobbylandSessionStore
): Adapter {
  const updateSession = adapter.updateSession;
  if (!updateSession) return adapter;
  return {
    ...adapter,
    async updateSession(session) {
      const stored = await store.session.findUnique({
        where: { sessionToken: session.sessionToken },
      });
      if (stored?.authProvider === HOBBYLAND_PROVIDER_ID) {
        return stored as AdapterSession;
      }
      return updateSession(session);
    },
  };
}
