import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SearchableSelect from '@/components/manage/searchable-select';

describe('shared authorized searchable person selector', () => {
  const options = Array.from({ length: 250 }, (_, index) => ({ value: `person-${index}`, label: `Person ${index}` }));
  it('bounds large choice lists while retaining an existing stable ID beyond the first page', () => {
    const html = renderToStaticMarkup(React.createElement(SearchableSelect, { options, value: 'person-249', name: 'employeeId', label: 'employees', selectLabel: 'Employee', required: true }));
    expect(html).toContain('aria-label="Search employees"');
    expect(html).toContain('aria-label="Employee"');
    expect(html).toContain('name="employeeId"');
    expect(html).toContain('value="person-249" selected=""');
    expect(html).not.toContain('value="person-248"');
    expect(html).toContain('Showing the first 100 matches');
    expect(html).toContain('required=""');
  });
  it('retains every selected multi-value and renders only supplied authorized IDs', () => {
    const html = renderToStaticMarkup(React.createElement(SearchableSelect, { options, values: ['person-240', 'person-249'], multiple: true, name: 'individualIds', label: 'individuals' }));
    expect(html).toContain('multiple=""');
    expect(html).toContain('value="person-240" selected=""');
    expect(html).toContain('value="person-249" selected=""');
    expect(html).toContain('2 selected');
    expect(html).not.toContain('person-250');
  });
});
