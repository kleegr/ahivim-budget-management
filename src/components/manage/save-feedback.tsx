'use client';
import { useEffect, useState } from 'react';

export function clearSaveFeedback() {
  window.dispatchEvent(new Event('ahivim-save-started'));
}

/** Save only the responsibility editor's disclosure context, never unrelated
 * details elsewhere on a financial or scheduling page. Verify before reload. */
export function preserveResponsibilityView(message: string) {
  const scope = document.getElementById('responsibility');
  const setup = scope?.closest('details');
  const programs = scope?.querySelector('details');
  const context = JSON.stringify({ setupOpen: setup?.open, programsOpen: programs?.open, scrollX: window.scrollX, scrollY: window.scrollY });
  const values = [[`ahivim-responsibility-view:${window.location.pathname}`, context], [`ahivim-saved:${window.location.pathname}`, message]];
  for (const [key, value] of values) {
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) throw new Error('Could not preserve the current record view.');
  }
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
      const contextKey = `ahivim-responsibility-view:${window.location.pathname}`;
      const context = sessionStorage.getItem(contextKey);
      if (context) {
        const state = JSON.parse(context);
        const scope = document.getElementById('responsibility');
        const setup = scope?.closest('details');
        const programs = scope?.querySelector('details');
        if (setup && typeof state.setupOpen === 'boolean') setup.open = state.setupOpen;
        if (programs && typeof state.programsOpen === 'boolean') programs.open = state.programsOpen;
        sessionStorage.removeItem(contextKey);
        if (Number.isFinite(state.scrollX) && Number.isFinite(state.scrollY)) requestAnimationFrame(() => window.scrollTo(state.scrollX, state.scrollY));
      }
    } catch { /* No saved message when storage is disabled. */ }
    return () => window.removeEventListener('ahivim-save-started', clear);
  }, []);
  return message ? <p role="status" className="mb-4 rounded border border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-3 text-sm">{message}</p> : null;
}
