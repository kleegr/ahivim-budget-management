import type { RepresentativeAccount } from "./fixtures";

/** Expected server permissions, maintained independently from implementation presets. */
export const ACCESS_CONTRACT: Record<RepresentativeAccount["preset"], {
  users: boolean;
  ownerExport: boolean;
  classInvoices: boolean;
  transactionExport: boolean;
  safeEmployeeRoster: boolean;
}> = {
  owner: { users: true, ownerExport: true, classInvoices: true, transactionExport: true, safeEmployeeRoster: false },
  office_manager: { users: false, ownerExport: false, classInvoices: true, transactionExport: true, safeEmployeeRoster: false },
  budget_planner: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: true },
  staffing_manager: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: true },
  money_collector: { users: false, ownerExport: false, classInvoices: false, transactionExport: true, safeEmployeeRoster: false },
  class_billing: { users: false, ownerExport: false, classInvoices: true, transactionExport: false, safeEmployeeRoster: false },
  individual_parent: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
  employee: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
  agency: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
  agency_scheduler: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
  agency_staffing_manager: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
  agency_collector: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
  custom_access: { users: false, ownerExport: false, classInvoices: false, transactionExport: false, safeEmployeeRoster: false },
};
