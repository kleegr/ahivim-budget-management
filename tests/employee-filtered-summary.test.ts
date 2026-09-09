import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ query: "Alpha" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ q: state.query }) }));
import EmployeesList, { type EmployeeRow } from "@/components/employees/employees-list";
import PlanningEmployeesList from "@/components/employees/planning-employees-list";
import type { PlanningEmployeeDirectoryRow } from "@/lib/data/employee-directory";
const row = (id: string, name: string, transactions: number, hours: string): EmployeeRow => ({ id, name, externalRef: null, status: "active", archived: false, transactionCount: transactions, checkCount: transactions, billedHours: hours, individualsServed: 1, lastActivityDate: "2026-08-01", dealReadiness: null, missingDealTransactions: null, openSettlementItems: null });
describe("employee summary scope", () => {
  it("summarizes all matching directory records rather than the unfiltered roster", () => {
    const html = renderToStaticMarkup(React.createElement(EmployeesList, { rows: [row("1", "Alpha", 2, "10"), row("2", "Beta", 90, "500"), row("3", "Alpha Two", 3, "4")], canEdit: false }));
    const summary = html.match(/<section[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(summary).toContain("Employees in this view");
    expect(summary).toMatch(/Billing records[\s\S]*?>5<\/dd>/);
    expect(summary).toMatch(/Billed hours[\s\S]*?>14<\/dd>/);
    expect(summary).not.toContain("500");
  });
  it("keeps the staffing summary on the same full filtered roster", () => {
    const people = [{ id: "1", displayName: "Alpha", status: "active", archivedAt: null, activeAssignments: 2, assignedIndividuals: 1, pendingHours: "7", pendingSessions: 1, nextSessionDate: "2026-09-10", weeklyAvailabilityWindows: 1, upcomingTimeOff: 0 }, { id: "2", displayName: "Beta", status: "active", archivedAt: null, activeAssignments: 90, assignedIndividuals: 50, pendingHours: "500", pendingSessions: 40, nextSessionDate: "2026-09-10", weeklyAvailabilityWindows: 0, upcomingTimeOff: 0 }] as PlanningEmployeeDirectoryRow[];
    const html = renderToStaticMarkup(React.createElement(PlanningEmployeesList, { rows: people }));
    const summary = html.match(/<section[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(summary).toMatch(/Active assignments[\s\S]*?>2<\/dd>/);
    expect(summary).toMatch(/Hours scheduled[\s\S]*?>7<\/dd>/);
    expect(summary).toContain("1/1"); expect(summary).not.toContain("500");
  });
});
