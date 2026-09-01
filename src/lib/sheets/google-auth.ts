import { createSign } from "node:crypto";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

function decodeJsonCredential(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  try {
    candidates.push(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    // The raw form may already be JSON.
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next supported form.
    }
  }
  return null;
}

/** Supports either one service-account JSON secret or the familiar two fields. */
export function googleSheetsCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleServiceAccountCredentials | null {
  const jsonSecret = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonSecret) {
    const parsed = decodeJsonCredential(jsonSecret);
    const clientEmail = typeof parsed?.client_email === "string" ? parsed.client_email.trim() : "";
    const privateKey = typeof parsed?.private_key === "string" ? parsed.private_key : "";
    if (clientEmail && privateKey) {
      return { clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
    }
  }

  const clientEmail = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  const privateKey = env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  return clientEmail && privateKey ? { clientEmail, privateKey } : null;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** Exchange the configured service-account assertion for a short-lived Sheets token. */
export async function googleSheetsAccessToken(
  credentials: GoogleServiceAccountCredentials,
  request: typeof fetch = fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: credentials.clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64url(signer.sign(credentials.privateKey))}`;

  const response = await request(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("Google Sheets authorization was not accepted.");
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Google Sheets did not return an access token.");
  }
  return body.access_token;
}
