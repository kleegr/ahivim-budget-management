import { dec } from "@/lib/money";

/** UI/API percentage points only. Stored fractions never pass this boundary. */
export function percentInputToFraction(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new RangeError("Enter a percentage between 0% and 100%.");
  }
  const raw = String(value).trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/.test(raw)) {
    throw new RangeError("Enter a percentage between 0% and 100%.");
  }
  const percentagePoints = dec(raw.replace(/\s*%$/, ""));
  if (!percentagePoints.isFinite() || percentagePoints.lt(0) || percentagePoints.gt(100)) {
    throw new RangeError("Percentage must be between 0% and 100%.");
  }
  return percentagePoints.div(100).toDecimalPlaces(6).toFixed(6);
}
