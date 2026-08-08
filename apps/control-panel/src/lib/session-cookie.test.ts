import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOAuthState, OAUTH_STATE_COOKIE_NAME } from "./oauth-state";
import { createSession, SESSION_COOKIE_NAME } from "./session";
import { PANEL_COOKIE_ATTRIBUTES, serializeHttpOnlyCookie } from "./session-cookie";
import { MemoryKv, NOW, sessionPrincipal } from "./session-test-harness";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Cookie-authenticated panel writes that ride the session cookie.
 *
 * Form POSTs require same-origin Origin (`panel-csrf.ts`) — SameSite=Lax alone
 * is a site boundary and insufficient across *.splitch.dev. createServerFn
 * POSTs require TanStack CSRF middleware from `src/start.ts`.
 *
 * Adding a new surface: update this list in the same change and re-read
 * `session-cookie.ts`.
 */
const FORM_POST_COOKIE_AUTHENTICATED_WRITES = [
  "routes/auth.logout.ts",
  "routes/claim.consent.$attemptId.tsx",
] as const;

const CREATE_SERVER_FN_POST_WRITES = [
  "lib/claim-ceremony-functions.ts",
  "lib/control-plane-app-functions.ts",
  "lib/control-plane-experiment-functions.ts",
  "lib/control-plane-flag-functions.ts",
  "lib/control-plane-flag-mutations.ts",
  "lib/control-plane-metric-functions.ts",
  "lib/control-plane-organization-functions.ts",
  "lib/control-plane-settings-functions.ts",
  "lib/control-plane-verify-functions.ts",
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

function relative(path: string): string {
  return path.slice(SRC.length).replaceAll(sep, "/");
}

function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/** Hardcoded expected attributes — not the constant under test (B6). */
function assertCookieAttributes(cookie: string, cookieName: string): void {
  expect(cookie, `${cookieName}: must be HttpOnly`).toContain("HttpOnly");
  expect(cookie, `${cookieName}: must be Secure`).toContain("Secure");
  expect(cookie, `${cookieName}: must be SameSite=Lax (site CSRF boundary)`).toContain(
    "SameSite=Lax",
  );
  expect(cookie, `${cookieName}: must include Path=/`).toContain("Path=/");
  expect(cookie, `${cookieName}: must set Max-Age`).toMatch(/Max-Age=\d+/);
  expect(cookie, `${cookieName}: must not set Domain (host-only)`).not.toMatch(/Domain=/i);
  expect(cookie, `${cookieName}: SameSite=None would make panel writes forgeable`).not.toMatch(
    /SameSite=None/i,
  );
  expect(cookie, `${cookieName}: must not drift to SameSite=Strict`).not.toMatch(
    /SameSite=Strict/i,
  );
}

/** createServerFn({ method: "POST" ... }) including extra option keys. */
function declaresPostServerFn(source: string): boolean {
  return /createServerFn\(\s*\{[\s\S]*?\bmethod:\s*["']POST["']/.test(source);
}

/** Session loaded in-file or via the authorized-* helpers / their module. */
function usesSessionCookie(source: string): boolean {
  return (
    /from\s+["']\.\/session["']/.test(source) ||
    /from\s+["']\.\/panel-authorized-clients["']/.test(source) ||
    /loadSessionFromRequest|authorizedFlagsClient|authorizedApprovalsClient/.test(source)
  );
}

/**
 * Cookie-value construction outside the shared serializer: a name=value pair
 * with any cookie attribute, or an inline Set-Cookie header value literal.
 * Attribute-less cookies are caught by the name=value; Path=/ shape; careful
 * SameSite=None literals are also caught.
 */
function cookieValueConstruction(source: string): string | null {
  const inlineHeader = /(?:set-cookie|Set-Cookie)\s*["']\s*,\s*[`"'][^`"']*=/;
  if (inlineHeader.test(source)) return "inline Set-Cookie header value";

  const constructed =
    /[`"'](?:__)?[A-Za-z][\w-]*=(?:\$\{[^}]+\}|[^`'";\n]+)(?:;[^`"'\n]*)?(?:Path|Max-Age|SameSite|HttpOnly|Secure|Domain)\b/i;
  if (constructed.test(source)) return "cookie value construction with attributes";

  // Attribute-less host cookie: `__name=${...}; Path=/` already covered above.
  // Also catch bare `__name=value; Path=/` without template.
  const barePath = /[`"'](?:__)?[A-Za-z][\w-]*=[^`'";\n]*;\s*Path\s*=/i;
  if (barePath.test(source)) return "cookie value with Path=";

  return null;
}

describe("panel cookie attributes", () => {
  it("pins the exact serializer output including host-only (no Domain)", () => {
    const cookie = serializeHttpOnlyCookie("__probe", "value", { maxAge: 60 });

    expect(cookie).toBe("__probe=value; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60");
    assertCookieAttributes(cookie, "__probe");
    expect(PANEL_COOKIE_ATTRIBUTES).toEqual(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]);
  });

  it("applies the same attributes to every cookie the panel sets", async () => {
    const kv = new MemoryKv();
    const session = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    const oauth = await createOAuthState(kv.namespace(), "/", NOW);

    assertCookieAttributes(session.cookie, SESSION_COOKIE_NAME);
    assertCookieAttributes(oauth.cookie, OAUTH_STATE_COOKIE_NAME);
  });

  it("builds every cookie value through serializeHttpOnlyCookie", () => {
    const offenders: string[] = [];

    for (const path of sourceFiles(SRC)) {
      const relativePath = relative(path);
      if (relativePath === "lib/session-cookie.ts") continue;

      const source = code(readFileSync(path, "utf8"));
      const kind = cookieValueConstruction(source);
      if (kind) {
        offenders.push(`${relativePath}: ${kind}`);
      }
    }

    expect(offenders).toEqual([]);
    expect(code(readFileSync(join(SRC, "lib/session.ts"), "utf8"))).toContain(
      "serializeHttpOnlyCookie",
    );
    expect(code(readFileSync(join(SRC, "lib/oauth-state.ts"), "utf8"))).toContain(
      "serializeHttpOnlyCookie",
    );
  });

  it("enumerates every cookie-authenticated panel write surface", () => {
    const formPosts: string[] = [];
    const serverFnPosts: string[] = [];

    for (const path of sourceFiles(SRC)) {
      const relativePath = relative(path);
      const source = code(readFileSync(path, "utf8"));

      if (
        relativePath.startsWith("routes/") &&
        /\bPOST\s*:/.test(source) &&
        /loadSessionFromRequest|destroyPanelSession|destroySession|forwardClaimConsent/.test(source)
      ) {
        formPosts.push(relativePath);
      }

      if (declaresPostServerFn(source) && usesSessionCookie(source)) {
        serverFnPosts.push(relativePath);
      }
    }

    expect(formPosts.sort()).toEqual([...FORM_POST_COOKIE_AUTHENTICATED_WRITES].sort());
    expect(serverFnPosts.sort()).toEqual([...CREATE_SERVER_FN_POST_WRITES].sort());
  });
});
