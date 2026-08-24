import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, safeRedirectPath } from "@/lib/auth/session";
import SignInForm from "./signin-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in — Ahivim Budget Management" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const next = safeRedirectPath(first("next"), "/home");
  if (await currentUser()) redirect(next);

  const error = first("error") ?? null;
  const notice = first("notice") ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-6 py-7 shadow-sm">
        <p className="eyebrow">Ahivim</p>
        <h1 className="display mt-1 text-2xl font-medium">Budget Management</h1>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          Sign in to review authorizations, imports and payroll transactions.
        </p>

        <SignInForm next={next} initialError={error} notice={notice} />

        <p className="mt-6 border-t border-[var(--color-rule)] pt-4 text-xs text-[var(--color-ink-faint)]">
          Accounts are created by an administrator. There is no public sign-up. If you cannot get
          in, ask an administrator to reset your access.
        </p>
      </div>

      <p className="mt-6 text-center text-xs text-[var(--color-ink-faint)]">
        <Link className="underline underline-offset-2" href="/api/health/db">
          System health
        </Link>
      </p>
    </main>
  );
}
