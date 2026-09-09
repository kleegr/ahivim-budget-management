'use client';
import { useEffect, useState } from 'react';

export function clearSaveFeedback() {
  window.dispatchEvent(new Event('ahivim-save-started'));
}

/** Keep the existing form's full refresh, including its selected tab and anchor,
 * while carrying the success message into the newly loaded record. */
export function refreshWithSaveFeedback(message: string) {
  try { sessionStorage.setItem(`ahivim-saved:${window.location.pathname}`, message); } catch { /* Saving still succeeds without browser storage. */ }
  window.location.reload();
}

export default function SaveFeedback() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const clear = () => setMessage(null);
    window.addEventListener('ahivim-save-started', clear);
    try {
      const key = `ahivim-saved:${window.location.pathname}`;
      const saved = sessionStorage.getItem(key);
      if (saved) { setMessage(saved); sessionStorage.removeItem(key); }
    } catch { /* No saved message when storage is disabled. */ }
    return () => window.removeEventListener('ahivim-save-started', clear);
  }, []);
  return message ? <p role="status" className="mb-4 rounded border border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-3 text-sm">{message}</p> : null;
}
