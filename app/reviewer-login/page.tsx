import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  createReviewerSession,
  isReviewerLoginEnabled,
  sessionCookieName,
  verifyReviewerCredentials,
} from "@/lib/reviewer-login";

export const metadata = {
  title: "Reviewer sign-in - OpenReply",
  robots: { index: false, follow: false },
};

// Password sign-in for the Meta App Review tester. Returns 404 unless
// REVIEWER_EMAIL and REVIEWER_PASSWORD are set; see lib/reviewer-login.ts.
export default async function ReviewerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!isReviewerLoginEnabled()) notFound();

  const params = await searchParams;
  const failed = params.error === "1";

  async function signInReviewer(formData: FormData) {
    "use server";
    if (!isReviewerLoginEnabled()) notFound();

    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    if (!verifyReviewerCredentials(email, password)) {
      // Slow down guessing; the password is long and random anyway.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      redirect("/reviewer-login?error=1");
    }

    const { sessionToken, expires } = await createReviewerSession();
    const cookieStore = await cookies();
    cookieStore.set(sessionCookieName(), sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieName().startsWith("__Secure-"),
      path: "/",
      expires,
    });
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            App Review tester sign-in
          </p>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {failed && (
            <p className="mb-5 text-sm text-red-500">
              Email or password is incorrect.
            </p>
          )}
          <form action={signInReviewer} className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="email"
                className="block text-sm font-medium text-foreground"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="username"
                className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground focus:border-accent/40 focus:outline-none transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-foreground"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground focus:border-accent/40 focus:outline-none transition-colors"
              />
            </div>
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30"
            >
              Sign in
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
