export interface SeriesVersionContextInput {
  supersedesSeriesId: string | null;
  successorSeriesId: string | null;
}

export interface SeriesVersionContext {
  startPrefix: "Starts" | null;
  endPrefix: "Current through" | "through";
}

export interface SeriesEditContext {
  targetSeriesId: string;
  label: "Edit upcoming" | "Edit schedule";
}

/** Copy-state for the effective-date cell of a versioned service schedule. */
export function seriesVersionContext(input: SeriesVersionContextInput): SeriesVersionContext {
  return {
    startPrefix: input.supersedesSeriesId !== null ? "Starts" : null,
    endPrefix: input.successorSeriesId !== null ? "Current through" : "through",
  };
}

/** A predecessor always directs edits to its already-created upcoming version. */
export function seriesEditContext(seriesId: string, successorSeriesId: string | null): SeriesEditContext {
  return successorSeriesId
    ? { targetSeriesId: successorSeriesId, label: "Edit upcoming" }
    : { targetSeriesId: seriesId, label: "Edit schedule" };
}
