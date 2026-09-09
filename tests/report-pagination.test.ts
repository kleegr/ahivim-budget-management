import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReportGrid from '@/components/reports/report-grid';
import { reportPage } from '@/components/reports/report-pagination';
import type { ReportTable } from '@/lib/data/report-queries';
import { applyFilters } from '@/components/data-grid/engine';
import type { ColumnDef } from '@/components/data-grid/types';
describe('report display pagination preserves the complete result', () => {
  it('renders only 50 of 2,000 transaction rows while showing complete matching totals', () => {
    const table: ReportTable = { key: 'transactions', columns: [{ key: 'individualName', header: 'Individual', type: 'text' }, { key: 'funderBilled', header: 'Funder billed', type: 'money' }], rows: Array.from({ length: 2000 }, (_, index) => ({ individualName: `Synthetic person ${index}`, individualId: `person-${index}`, employeeId: 'worker', funderBilled: '100', employeeBase: '60', agencySpread: '40', hours: '2' })) };
    const html = renderToStaticMarkup(React.createElement(ReportGrid, { table, reportKey: 'transactions', canManage: false }));
    const body = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? '';
    expect(body.match(/<tr\b/g)).toHaveLength(50);
    expect(body).toContain('Synthetic person 49'); expect(body).not.toContain('Synthetic person 50');
    expect(html).toContain('$200,000.00'); expect(html).toContain('of 2,000 matching rows');
    expect(html).toContain('Totals and exports include every matching row');
    expect(table.rows).toHaveLength(2000);
  });
  it('reaches every page without duplicates and bounds stale or invalid page requests', () => {
    const rows = Array.from({ length: 123 }, (_, id) => ({ id }));
    const pages = [1, 2, 3].flatMap(page => reportPage(rows, page).visibleRows);
    expect(pages).toEqual(rows); expect(reportPage(rows, 10).visibleRows).toHaveLength(23);
    expect(reportPage([], 9)).toMatchObject({ currentPage: 1, pageCount: 1, visibleRows: [] });
    expect(reportPage(rows, Number.NaN).currentPage).toBe(1);
  });
  it('searches the complete result before paging, including records beyond the first page', () => {
    const rows = Array.from({ length: 123 }, (_, id) => ({ name: `Person ${id}`, id }));
    const columns: ColumnDef<(typeof rows)[number]>[] = [{ key: 'name', label: 'Name', kind: 'text', accessor: row => row.name }];
    const filtered = applyFilters(rows, columns, {}, 'Person 122', ['name']);
    expect(reportPage(filtered, 1).visibleRows).toEqual([{ name: 'Person 122', id: 122 }]);
    expect(rows).toHaveLength(123);
  });
});
