/** A typed outcome so route handlers can map failures to HTTP status codes. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: ResultCode; message: string };

export type ResultCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "forbidden"
  | "immutable";

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (code: ResultCode, message: string): Result<never> => ({
  ok: false,
  code,
  message,
});

export const STATUS: Record<ResultCode, number> = {
  not_found: 404,
  conflict: 409,
  validation: 400,
  forbidden: 403,
  immutable: 409,
};
