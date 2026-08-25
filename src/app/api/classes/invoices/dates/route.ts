import { type NextRequest, NextResponse } from "next/server";
import { apiClassFinancialUser } from "@/lib/auth/class-financial-access";
import {
  DEFAULT_MONTHLY_CLASS_DAYS,
  generateMonthlyClassDates,
} from "@/lib/business/class-invoicing";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await apiClassFinancialUser("view");
  if (!access) return jsonError("Class financial access required", 403);
  const month = request.nextUrl.searchParams.get("month") ?? "";
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit ? Number(rawLimit) : DEFAULT_MONTHLY_CLASS_DAYS;
  try {
    const dates = generateMonthlyClassDates(month, limit);
    return NextResponse.json({
      ok: true,
      data: { month, dates, targetDays: DEFAULT_MONTHLY_CLASS_DAYS },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not generate class dates.", 400);
  }
}
