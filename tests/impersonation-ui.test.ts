import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const users = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");
const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
const bar = readFileSync("src/components/auth/impersonation-bar.tsx", "utf8");
const nav = readFileSync("src/components/app-nav.tsx", "utf8");
const settings = readFileSync("src/app/(app)/settings/page.tsx", "utf8");

describe("owner view-as interface", () => {
  it("offers a native full-page switch only for active, non-current users", () => {
    expect(users).toContain("const self = u.id === currentUserId");
    expect(users).toContain("{u.isActive ? (");
    expect(users).toContain('action="/api/auth/impersonation/start"');
    expect(users).toContain('name="targetUserId" value={u.id}');
    expect(users).toContain("Sign in as");
  });

  it("renders the real target application with only a compact return control added", () => {
    expect(layout).toContain("const user = await requireUser");
    expect(layout).toContain("const impersonation = await currentImpersonation()");
    expect(layout).toContain("<AppNav");
    expect(layout).toContain("user={user}");
    expect(layout).toContain("<ImpersonationBar impersonation={impersonation}");
    expect(layout).toContain("accountLabel={accountLabel}");
    expect(layout).toContain("[--impersonation-bar-height:2.75rem]");
    expect(bar).toContain("Viewing as");
    expect(bar).toContain("- {accountLabel}");
    expect(bar).toContain("flex h-11 items-center");
    expect(bar).toContain("Return to owner portal");
    expect(bar).toContain('action="/api/auth/impersonation/stop"');
  });

  it("shows the effective preset throughout the preview instead of the generic database role", () => {
    expect(layout).toContain("resolveAccountProfile(user.role, scope, portal, user.accountPreset).label");
    expect(settings).toContain("resolveAccountProfile(user.role, scope, portal, user.accountPreset).label");
    expect(nav).toContain("<UserFooter user={user} accountLabel={accountLabel}");
    expect(nav).not.toContain('viewer: "Viewer"');
    expect(settings).toContain("label={result.ok ? result.data.accountLabel");
    expect(bar).toContain("- {accountLabel}");
  });

  it("shows preview transition failures inside the application", () => {
    expect(settings).toContain("Could not open that user portal");
    expect(settings).toContain("previewError");
    expect(bar).toContain('useSearchParams().get("previewError")');
    expect(bar).toContain("Could not return:");
  });
});
