export type OwnerViewConfig = {
  checkDateFrom: string | null;
  checkDateTo: string | null;
  individualIds: string[];
  employeeId: string | null;
  payrollPeriod: string | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeOwnerViewConfig(value: unknown): OwnerViewConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return {
    checkDateFrom: text(source.checkDateFrom),
    checkDateTo: text(source.checkDateTo),
    individualIds: Array.isArray(source.individualIds)
      ? [...new Set(source.individualIds
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim()))].slice(0, 100)
      : [],
    employeeId: text(source.employeeId),
    payrollPeriod: text(source.payrollPeriod),
  };
}

export function ownerViewHref(value: unknown): string | null {
  const config = normalizeOwnerViewConfig(value);
  if (!config) return null;
  const params = new URLSearchParams();
  if (config.checkDateFrom) params.set("from", config.checkDateFrom);
  if (config.checkDateTo) params.set("to", config.checkDateTo);
  for (const id of config.individualIds) params.append("individualId", id);
  if (config.employeeId) params.set("employeeId", config.employeeId);
  if (config.payrollPeriod) params.set("payrollPeriod", config.payrollPeriod);
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}
