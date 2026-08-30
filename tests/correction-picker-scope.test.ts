import { describe, expect, it } from "vitest";
import { correctionPersonPickerFilter } from "@/lib/manage/import-corrections";

describe("historical import correction pickers", () => {
  it("includes inactive and discharged records while keeping archived records unavailable", () => {
    const filter = correctionPersonPickerFilter();

    expect(filter).toEqual({ includeArchived: false });
    expect("status" in filter).toBe(false);
  });
});
