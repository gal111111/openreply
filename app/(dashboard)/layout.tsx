import { I18nProvider } from "@/lib/i18n/provider";
import { getI18n } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t("OpenReply - Open source Instagram comment-to-DM automation") };
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { locale, t } = await getI18n();
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );
  if (!workspace) {
    // HobbyLand unified-login users are invite-only: no workspace is created
    // for them, so show how to get access instead of an empty dashboard.
    async function signOutAction() {
      "use server";
      await signOut({ redirectTo: "/login" });
    }

    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="w-full max-w-md panel rounded p-8 text-center">
          <h1 className="text-lg font-semibold text-foreground">
            {t("You have not joined a workspace yet")}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {t("Ask a workspace owner or admin to invite {email}. You can use OpenReply after you accept the invitation.", {
              email: session.user.email ?? "",
            })}
          </p>
          <form action={signOutAction} className="mt-6">
            <button
              type="submit"
              className="w-full rounded border border-border px-6 py-3 text-sm font-semibold text-foreground"
            >
              {t("Sign out")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { username: true },
  });

  return (
    <I18nProvider locale={locale}>
      <DashboardShell
        workspaceName={workspace.name}
        instagramUsername={accounts[0]?.username ?? null}
        instagramAccountCount={accounts.length}
      >
        {children}
      </DashboardShell>
    </I18nProvider>
  );
}
