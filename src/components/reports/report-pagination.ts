export const REPORT_PAGE_SIZE = 50;

/** A display page never changes the complete filtered collection. */
export function reportPage<Row>(rows: Row[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / REPORT_PAGE_SIZE));
  const currentPage = Math.max(1, Math.min(pageCount, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const pageStart = (currentPage - 1) * REPORT_PAGE_SIZE;
  return { pageCount, currentPage, pageStart, visibleRows: rows.slice(pageStart, pageStart + REPORT_PAGE_SIZE) };
}
