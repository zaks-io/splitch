const TOKEN_PREFIX = "spl_";
const TOKEN_HEX_LENGTH = 64;
const SESSION_TOKEN_PATTERN = /^spl_[0-9a-f]{64}$/;

/**
 * The Control Panel has no CSRF token layer.
 *
 * Cookie-authenticated writes — the classic form POSTs at `/auth/logout` and
 * `/claim/consent/$attemptId`, plus every `createServerFn({ method: "POST" })`
 * that reads the session cookie — are protected by these cookie attributes.
 * `SameSite=Lax` is the CSRF mechanism: browsers withhold the cookie from a
 * cross-site POST, so a forged submit arrives with no session. Loosen it to
 * `None` (a plausible reach when debugging cross-origin or embedded-preview
 * problems) and every panel write becomes forgeable; no silent fallback is
 * allowed (ADR-0036 / SPL-263).
 *
 * `HttpOnly` keeps the token off `document.cookie`. `Secure` keeps it off
 * cleartext. `Path=/` scopes it to the panel origin. There is intentionally
 * no knobs API for these flags — change them here and
 * `session-cookie.test.ts` goes red naming the security consequence.
 *
 * TanStack Start also Origin-checks `createServerFn` POSTs. That does not
 * cover the form POSTs above; those rest on `SameSite=Lax` alone. Do not
 * weaken these attributes without adding an explicit CSRF token layer.
 */
export const PANEL_COOKIE_PROTECTIVE_ATTRIBUTES = [
  "HttpOnly",
  "Secure",
  "SameSite=Lax",
  "Path=/",
] as const;

export function generateOpaqueToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isOpaqueToken(token: string): boolean {
  return (
    token.length === TOKEN_PREFIX.length + TOKEN_HEX_LENGTH && SESSION_TOKEN_PATTERN.test(token)
  );
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export function serializeHttpOnlyCookie(
  name: string,
  value: string,
  options: { maxAge: number },
): string {
  return `${name}=${encodeURIComponent(value)}; ${PANEL_COOKIE_PROTECTIVE_ATTRIBUTES.join("; ")}; Max-Age=${options.maxAge}`;
}

export function clearHttpOnlyCookie(name: string): string {
  return serializeHttpOnlyCookie(name, "", { maxAge: 0 });
}

export function parseCookie(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name || valueParts.length === 0) {
      continue;
    }
    try {
      cookies.set(name, decodeURIComponent(valueParts.join("=")));
    } catch {
      cookies.set(name, "");
    }
  }
  return cookies;
}

export function nowSeconds(now: number): number {
  return Math.floor(now / 1000);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
