import { redirect } from "next/navigation";
import { withDb } from "@/lib/data/pool";
import { getSetting } from "@/lib/manage/app-settings";

export const dynamic = "force-dynamic";

/**
 * Application entry point. Sends people to whichever workspace the team has
 * chosen as its default landing page (Transactions or Calculations), falling
 * back to the dashboard. Middleware handles anonymity.
 */
export default async function RootPage() {
  const result = await withDb((pool) => getSetting<string>(pool, "default_landing"));
  const choice = result.ok ? result.data : null;
  const dest =
    choice === "transactions"
      ? "/transactions"
      : choice === "individuals"
        ? "/individuals"
        : choice === "calculations"
          ? "/calculations"
          : "/dashboard";
  redirect(dest);
}
