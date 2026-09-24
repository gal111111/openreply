import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { isEmailAllowedToSignIn } from "@/lib/env";

/**
 * Password sign-in for the Meta App Review tester only.
 *
 * Meta reviewers cannot receive magic-link emails, and a review whose login
 * fails is rejected outright. This path exists only while REVIEWER_EMAIL and
 * REVIEWER_PASSWORD are both set; unset either to switch it off entirely. It
 * signs in exactly one address, which gets its own workspace like any new
 * user, and it still honours ALLOWED_EMAILS.
 */

const MIN_PASSWORD_LENGTH = 20;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function reviewerEmail(): string | null {
  const email = process.env.REVIEWER_EMAIL?.trim().toLowerCase();
  return email ? email : null;
}

function reviewerPassword(): string | null {
  const password = process.env.REVIEWER_PASSWORD;
  if (!password || password.length < MIN_PASSWORD_LENGTH) return null;
  return password;
}

export function isReviewerLoginEnabled(): boolean {
  return reviewerEmail() !== null && reviewerPassword() !== null;
}

// Hash both sides first so the comparison is constant-time regardless of length.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function verifyReviewerCredentials(
  email: string,
  password: string
): boolean {
  const expectedEmail = reviewerEmail();
  const expectedPassword = reviewerPassword();
  if (!expectedEmail || !expectedPassword) return false;
  if (!isEmailAllowedToSignIn(expectedEmail)) return false;

  const emailOk = safeEqual(email.trim().toLowerCase(), expectedEmail);
  const passwordOk = safeEqual(password, expectedPassword);
  return emailOk && passwordOk;
}

/**
 * Creates a database session for the reviewer, the same row Auth.js writes
 * for a magic-link sign-in, and returns the token to set as the session cookie.
 */
export async function createReviewerSession(): Promise<{
  sessionToken: string;
  expires: Date;
}> {
  const email = reviewerEmail();
  if (!email) throw new Error("Reviewer login is not enabled");

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, emailVerified: new Date() },
  });
  await ensureWorkspaceForUser(user.id, user.email);

  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires },
  });

  return { sessionToken, expires };
}

/** Auth.js v5 prefixes the cookie with __Secure- on https deployments. */
export function sessionCookieName(): string {
  const url = process.env.NEXTAUTH_URL ?? "";
  return url.startsWith("https://")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}
