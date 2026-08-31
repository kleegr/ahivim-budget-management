import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Compatibility route for saved links from the former Collections page. */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, item);
    }
  }
  redirect(params.size > 0 ? `/masser?${params.toString()}` : "/masser");
}
