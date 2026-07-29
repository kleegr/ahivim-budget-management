import { describe, it, expect } from "vitest";
import { attributePayment } from "@/lib/manage/payment-attribution";
import { dec } from "@/lib/money";

const n = (s: string | null) => (s === null ? null : dec(s).toNumber());

describe("attributePayment (pure)", () => {
  it("computes agency additional as gross − internal for the $19 / $17 case", () => {
    const r = attributePayment({
      payToRaw: "Excellent Staffing",
      employeeName: "Miriam Klein",
      importedAmount: "19",
      internalAmount: "17",
    });
    expect(n(r.agencyAdditional)).toBe(2);
  });

  it("Excellent Staffing must pay the employee: recipient is the agency, employee amount = internal", () => {
    const r = attributePayment({
      payToRaw: "EXCELLENT STAFFING LLC",
      employeeName: "Miriam Klein",
      importedAmount: "19",
      internalAmount: "17",
    });
    expect(r.recipient).toBe("excellent_staffing");
    // The agency is responsible for paying the employee the internal amount —
    // this must NOT be null (it feeds the "payable by agency" report bucket).
    expect(n(r.employeePayment)).toBe(17);
    expect(n(r.agencyAdditional)).toBe(2);
    expect(r.reason).toMatch(/agency marker/i);
    expect(r.reason).toMatch(/responsible for paying the employee/i);
  });

  it("classifies a payee equal to the employee name as employee, paid the internal amount", () => {
    const r = attributePayment({
      payToRaw: "Miriam Klein",
      employeeName: "Miriam Klein",
      importedAmount: "19",
      internalAmount: "17",
    });
    expect(r.recipient).toBe("employee");
    expect(n(r.employeePayment)).toBe(17);
    expect(n(r.agencyAdditional)).toBe(2);
  });

  it("matches the employee across a Last, First ordering", () => {
    const r = attributePayment({
      payToRaw: "Klein, Miriam",
      employeeName: "Miriam Klein",
      importedAmount: "17",
      internalAmount: "17",
    });
    expect(r.recipient).toBe("employee");
    expect(n(r.agencyAdditional)).toBe(0);
  });

  it("floors a negative agency additional at zero and says so", () => {
    const r = attributePayment({
      payToRaw: "Someone Else",
      employeeName: "Miriam Klein",
      importedAmount: "17",
      internalAmount: "19",
    });
    expect(n(r.agencyAdditional)).toBe(0);
    expect(r.reason).toMatch(/negative/i);
  });

  it("is unknown when the payee neither marks the agency nor matches the employee", () => {
    const r = attributePayment({
      payToRaw: "Some Vendor",
      employeeName: "Miriam Klein",
      importedAmount: "19",
      internalAmount: "17",
    });
    expect(r.recipient).toBe("unknown");
    expect(r.employeePayment).toBeNull();
  });

  it("is unknown with a null agency additional when the pay-to is blank and an amount is missing", () => {
    const r = attributePayment({
      payToRaw: "",
      employeeName: "Miriam Klein",
      importedAmount: "19",
      internalAmount: null,
    });
    expect(r.recipient).toBe("unknown");
    expect(r.agencyAdditional).toBeNull();
  });
});
