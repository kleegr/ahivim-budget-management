"use client";

import { useId, useMemo, useState } from "react";

export interface SearchableOption { value: string; label: string; disabled?: boolean }
export interface SearchableSelectProps {
  options: SearchableOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  values?: string[];
  onValuesChange?: (values: string[]) => void;
  multiple?: boolean;
  name?: string;
  label?: string;
  selectLabel?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Search only the authorized choices provided by the server. Native select
 * preserves keyboard, form validation and single/multi-selection semantics. */
export default function SearchableSelect({ options, value, defaultValue = "", onChange,
  values, onValuesChange, multiple = false, name, label = "person", selectLabel, placeholder = "Choose…",
  required, disabled, className = "select w-full" }: SearchableSelectProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState(defaultValue);
  const [localValues, setLocalValues] = useState<string[]>([]);
  const selected = value ?? local;
  const selectedValues = values ?? localValues;
  const selectedSet = new Set(multiple ? selectedValues : [selected]);
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return options.filter((option) => !needle || option.label.toLocaleLowerCase().includes(needle));
  }, [options, query]);
  const visible = [...options.filter((option) => selectedSet.has(option.value)),
    ...matching.filter((option) => !selectedSet.has(option.value)).slice(0, 100)];
  return <div className="min-w-0 space-y-1">
    <input type="search" className="input w-full" aria-label={`Search ${label}`} aria-controls={id}
      placeholder={`Search ${label}…`} value={query} disabled={disabled}
      onChange={(event) => setQuery(event.target.value)} />
    <select id={id} className={className} name={name} aria-label={selectLabel ?? `Select ${label}`}
      multiple={multiple} size={multiple ? 5 : undefined} value={multiple ? selectedValues : selected}
      required={required} disabled={disabled} onChange={(event) => {
        if (multiple) {
          const next = Array.from(event.target.selectedOptions, (option) => option.value);
          setLocalValues(next); onValuesChange?.(next);
        } else { setLocal(event.target.value); onChange?.(event.target.value); }
      }}>
      {!multiple ? <option value="">{placeholder}</option> : null}
      {visible.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {matching.length === 0 ? <p role="status" className="text-xs text-[var(--color-ink-soft)]">No matching {label}. Your selection is retained.</p> : null}
    {matching.length > 100 ? <p className="text-xs text-[var(--color-ink-soft)]">Showing the first 100 matches. Keep typing to narrow the list.</p> : null}
    {multiple ? <p className="text-xs text-[var(--color-ink-soft)]">{selectedValues.length} selected. Use Ctrl or Command to select more than one.</p> : null}
  </div>;
}
