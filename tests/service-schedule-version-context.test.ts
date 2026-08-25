import { describe, expect, it } from "vitest";
import { seriesEditContext, seriesVersionContext } from "@/components/schedule/version-context";

describe("service schedule version context", () => {
  it("labels the current row as ending for its successor", () => {
    expect(seriesVersionContext({
      supersedesSeriesId: null,
      successorSeriesId: "successor-id",
    })).toEqual({ startPrefix: null, endPrefix: "Current through" });
  });

  it("labels a successor row as the start of a new schedule version", () => {
    expect(seriesVersionContext({
      supersedesSeriesId: "previous-id",
      successorSeriesId: null,
    })).toEqual({ startPrefix: "Starts", endPrefix: "through" });
  });

  it("supports a middle version in a longer schedule history", () => {
    expect(seriesVersionContext({
      supersedesSeriesId: "previous-id",
      successorSeriesId: "next-id",
    })).toEqual({ startPrefix: "Starts", endPrefix: "Current through" });
  });

  it("directs a predecessor's edit action to its upcoming version", () => {
    expect(seriesEditContext("current-id", "upcoming-id")).toEqual({
      targetSeriesId: "upcoming-id",
      label: "Edit upcoming",
    });
    expect(seriesEditContext("latest-id", null)).toEqual({
      targetSeriesId: "latest-id",
      label: "Edit schedule",
    });
  });
});
