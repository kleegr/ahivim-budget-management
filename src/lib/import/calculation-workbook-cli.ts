export interface CalculationWorkbookCliOptions {
  file: string;
  out: string | null;
  apply: boolean;
  confirmDisposable: boolean;
  actorId: string | null;
  asOf: string | null;
  help: boolean;
}

export function calculationWorkbookCliUsage(): string {
  return [
    "Usage: npm run calculation:reconcile -- --file <Calculations.xlsx> [options]",
    "",
    "Options:",
    "  --out <report.json>       Also save the machine-readable report.",
    "  --as-of <YYYY-MM-DD>      Business date used to select effective rates.",
    "  --actor-id <uuid>         Optional audit actor (must exist in users).",
    "  --apply                   Insert only unequivocally missing strategies.",
    "  --confirm-disposable      Required with --apply; apply uses TEST_DATABASE_URL only.",
    "  --help                    Show this help.",
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function parseCalculationWorkbookCliArgs(
  args: string[],
): CalculationWorkbookCliOptions {
  const options: CalculationWorkbookCliOptions = {
    file: "",
    out: null,
    apply: false,
    confirmDisposable: false,
    actorId: null,
    asOf: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--confirm-disposable") {
      options.confirmDisposable = true;
    } else if (argument === "--file") {
      options.file = nextValue(args, index, argument);
      index += 1;
    } else if (argument === "--out") {
      options.out = nextValue(args, index, argument);
      index += 1;
    } else if (argument === "--actor-id") {
      options.actorId = nextValue(args, index, argument);
      index += 1;
    } else if (argument === "--as-of") {
      options.asOf = nextValue(args, index, argument);
      index += 1;
    } else if (!argument.startsWith("-") && options.file === "") {
      // Keep the original positional-file convenience while documenting --file.
      options.file = argument;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.help && !options.file.trim()) {
    throw new Error(
      "Pass the Calculations workbook path with --file. The command is a dry run unless --apply is present.",
    );
  }
  if (options.apply && !options.confirmDisposable) {
    throw new Error("--apply requires --confirm-disposable.");
  }
  if (
    options.actorId !== null
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.actorId)
  ) {
    throw new Error("--actor-id must be a UUID.");
  }
  if (options.asOf !== null && !isIsoDate(options.asOf)) {
    throw new Error("--as-of must be a real calendar date in YYYY-MM-DD form.");
  }
  return options;
}

type ConnectionEnvironment = Record<string, string | undefined>;

/**
 * Apply is deliberately narrower than dry-run: it can use only the explicitly
 * named test branch and is disabled inside a production Vercel runtime.
 */
export function calculationWorkbookConnectionString(
  options: Pick<CalculationWorkbookCliOptions, "apply">,
  environment: ConnectionEnvironment = process.env,
): string {
  if (options.apply) {
    if (environment.VERCEL_ENV?.toLowerCase() === "production") {
      throw new Error("Calculations workbook apply mode is disabled in a production runtime.");
    }
    const disposable = environment.TEST_DATABASE_URL?.trim();
    if (!disposable) {
      throw new Error(
        "Apply mode accepts only TEST_DATABASE_URL and requires a disposable database branch.",
      );
    }
    return disposable;
  }

  const candidates = [
    environment.TEST_DATABASE_URL,
    environment.DATABASE_URL,
    environment.POSTGRES_URL,
    environment.DATABASE_URL_UNPOOLED,
    environment.POSTGRES_URL_NON_POOLING,
    environment.POSTGRES_PRISMA_URL,
    environment.NEON_DATABASE_URL,
  ];
  const value = candidates.find((candidate) => candidate?.trim())?.trim();
  if (!value) throw new Error("No database connection variable was found for reconciliation.");
  return value;
}
