import { NextResponse } from "next/server";
import { STATUS } from "@/lib/manage/errors";
import type { ClassOperationResult } from "@/lib/manage/class-invoices";

/** Preserve structured class-budget warnings instead of flattening them to text. */
export function classResultResponse<T>(
  result: ClassOperationResult<T>,
  okStatus = 200,
): NextResponse {
  if (result.ok) {
    return NextResponse.json({ ok: true, data: result.data }, { status: okStatus });
  }
  return NextResponse.json(
    {
      ok: false,
      error: result.message,
      code: result.code,
      ...(result.details ? { details: result.details } : {}),
    },
    { status: STATUS[result.code] },
  );
}
