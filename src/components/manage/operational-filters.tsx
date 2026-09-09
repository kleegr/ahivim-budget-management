'use client';
import { RESPONSIBILITIES, RESPONSIBILITY_LABELS } from '@/lib/business/operational-responsibility';
export default function OperationalFilters({ management, review, onManagement, onReview, label = 'Management' }: {
  management: string; review: string; onManagement: (value: string) => void; onReview: (value: string) => void; label?: string;
}) {
  return <div className="flex flex-wrap gap-3" aria-label="Responsibility and review filters">
    <label className="min-w-48 flex-1 sm:flex-none"><span className="mb-1 block text-xs font-medium">{label}</span><select className="select w-full" value={management} onChange={(event) => onManagement(event.target.value)}><option value="all">Any responsibility</option>{RESPONSIBILITIES.map((value) => <option key={value} value={value}>{RESPONSIBILITY_LABELS[value]}</option>)}</select></label>
    <label className="min-w-48 flex-1 sm:flex-none"><span className="mb-1 block text-xs font-medium">Review state</span><select className="select w-full" value={review} onChange={(event) => onReview(event.target.value)}><option value="all">All review states</option><option value="needs_review">Detected issues</option><option value="clear">No detected issues</option></select></label>
  </div>;
}
