"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Posts JSON so the error can be shown in place without a full round trip,
 * but the form also works without JavaScript: the same route accepts a normal
 * form POST and redirects back with ?error=.
 */
export default function SignInForm({
  next,
  initialError,
  notice,
}: {
  next: string;
  initialError: string | null;
  notice: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
          next,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        redirectTo?: string;
      };
      if (!response.ok || !data.ok) {
        setError(data.error ?? "Sign-in failed. Try again.");
        setBusy(false);
        return;
      }
      router.replace(data.redirectTo ?? next);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-6 space-y-4"
      method="post"
      action="/api/auth/login"
      onSubmit={onSubmit}
      noValidate
    >
      <input type="hidden" name="next" value={next} />

      {notice ? (
        <p
          role="status"
          className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]"
        >
          {error}
        </p>
      ) : null}

      <div>
        <label className="block text-sm font-medium" htmlFor="email">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="input mt-1 w-full text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input mt-1 w-full text-sm"
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="btn btn-primary w-full"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
