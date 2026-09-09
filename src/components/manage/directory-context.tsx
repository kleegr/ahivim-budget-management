'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/** Keep directory context in the URL, including normal browser Back/reload. */
export function useDirectoryUrl(directory: 'individuals' | 'employees', values: Record<string, string>) {
  const serialized = JSON.stringify(values);
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(JSON.parse(serialized) as Record<string, string>)) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    const href = url.pathname + url.search + url.hash;
    if (href !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, '', href);
    try { sessionStorage.setItem(`ahivim-directory-${directory}`, href); } catch { /* URL is sufficient when storage is disabled. */ }
  }, [directory, serialized]);
}

export function DirectoryBackLink({ directory }: { directory: 'individuals' | 'employees' }) {
  const router = useRouter();
  return <Link className="mb-3 inline-block text-sm font-medium text-[var(--color-primary)] underline" href={`/${directory}`} onClick={(event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      const saved = sessionStorage.getItem(`ahivim-directory-${directory}`);
      if (saved && (saved === `/${directory}` || saved.startsWith(`/${directory}?`))) { event.preventDefault(); router.push(saved); }
    } catch { /* Follow the ordinary directory link. */ }
  }}>Back to {directory === 'individuals' ? 'people & budgets' : 'employees'}</Link>;
}
