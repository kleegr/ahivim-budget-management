/** Cache-Control directives are unordered, case-insensitive tokens. */
export function cacheControlDirectives(header: string | null | undefined): string[] {
  return (header ?? "").split(",").map((directive) => directive.trim().toLowerCase()).filter(Boolean);
}
