const TOKEN_PREFIX = "spl_";
const TOKEN_HEX_LENGTH = 64;
const SESSION_TOKEN_PATTERN = /^spl_[0-9a-f]{64}$/;
declare const serializedHttpOnlyCookieBrand: unique symbol;

export type SerializedHttpOnlyCookie = string & {
  readonly [serializedHttpOnlyCookieBrand]: true;
};

/**
 * Exact attribute set every Control Panel cookie must carry.
 *
 * The panel has no CSRF token layer. Cookie-authenticated writes are protected
 * as follows:
 *
 * - `SameSite=Lax` is a *site* boundary: browsers withhold the cookie from a
 *   cross-*site* POST, but `app.splitch.dev` shares a site with `auth.`,
 *   `api.`, `edge.`, `ingest.`, `mcp.`, and apex `splitch.dev`. Lax still
 *   sends `__session` on a POST from those siblings. Form POSTs therefore also
 *   require same-origin `Origin` via `rejectCrossOriginWrite` (`panel-csrf.ts`).
 *   `createServerFn` POSTs get TanStack's Origin / Sec-Fetch-Site middleware
 *   from `src/start.ts` (`panelServerFnCsrfMiddleware`). That check is
 *   contingent on the middleware remaining in `requestMiddleware` — displacing
 *   it removes CSRF from every server-fn write.
 * - `HttpOnly` keeps the token off `document.cookie`.
 * - `Secure` keeps it off cleartext.
 * - Host-only: `Domain` MUST be absent. A `Domain=.splitch.dev` would make the
 *   cookie sent to and settable by every `splitch.dev` host.
 * - `Path=/` is the widest path scope (not a security boundary). It is pinned
 *   so silent drift is a red test. `Max-Age` is set per call.
 *
 * There is no knobs API for these flags. Change them here and the cookie
 * invariant tests go red naming the attribute and the cookie (SPL-263).
 */
export const PANEL_COOKIE_ATTRIBUTES = ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] as const;

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
): SerializedHttpOnlyCookie {
  return `${name}=${encodeURIComponent(value)}; ${PANEL_COOKIE_ATTRIBUTES.join("; ")}; Max-Age=${options.maxAge}` as SerializedHttpOnlyCookie;
}

export function appendHttpOnlyCookie(headers: Headers, cookie: SerializedHttpOnlyCookie): void {
  headers.append("set-cookie", cookie);
}

export function clearHttpOnlyCookie(name: string): SerializedHttpOnlyCookie {
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
