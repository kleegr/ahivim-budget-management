import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The application entry point is the dashboard; middleware handles anonymity. */
export default function RootPage() {
  redirect("/dashboard");
}
