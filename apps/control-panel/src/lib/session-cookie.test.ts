import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createOAuthState, OAUTH_STATE_COOKIE_NAME } from "./oauth-state";
import { createSession, SESSION_COOKIE_NAME } from "./session";
import {
  PANEL_COOKIE_ATTRIBUTES,
  serializeHttpOnlyCookie,
  type SerializedHttpOnlyCookie,
} from "./session-cookie";
import {
  exportedPostServerFns,
  setCookieHeaderWrites,
} from "./session-cookie-source-guards.test-helper";
import { MemoryKv, NOW, sessionPrincipal } from "./session-test-harness";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Cookie-authenticated panel writes that ride the session cookie.
 *
 * Form POSTs require same-origin Origin (`panel-csrf.ts`) — SameSite=Lax alone
 * is a site boundary and insufficient across *.splitch.dev. createServerFn
 * POSTs require TanStack CSRF middleware from `src/start.ts`.
 *
 * Form POSTs remain an explicit route inventory. Exported createServerFn POSTs
 * are derived per declaration below so adding one to an existing module cannot
 * hide behind a filename that was already reviewed.
 */
const FORM_POST_COOKIE_AUTHENTICATED_WRITES = [
  "routes/auth.logout.ts",
  "routes/claim.consent.$attemptId.tsx",
] as const;

/**
 * Modules that reach the session cookie (directly or via authorized-client /
 * form-POST wrappers). One set for both createServerFn and form-POST
 * enumeration — do not maintain a second accessor-name list (SPL-263).
 */
const SESSION_REACHING_MODULES = [
  "session",
  "panel-authorized-clients",
  "logout",
  "claim-consent",
] as const;

const SESSION_REACHING_IMPORTS = new Set(
  SESSION_REACHING_MODULES.flatMap((module) => [`./${module}`, `#lib/${module}`]),
);

/** Form-POST helpers that already call `rejectCrossOriginWrite` before session work. */
const FORM_POST_ORIGIN_GUARDS = /rejectCrossOriginWrite|destroyPanelSession|forwardClaimConsent/;

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

/** Import of a session-reaching module (`./x` or `#lib/x`). */
function importsSessionReachingModule(source: string): boolean {
  const modules = SESSION_REACHING_MODULES.join("|");
  return new RegExp(String.raw`from\s+["'](?:\./|#lib/)(?:${modules})["']`).test(source);
}

/** Session loaded in-file or via a session-reaching module import. */
function usesSessionCookie(source: string): boolean {
  return importsSessionReachingModule(source);
}

function declaresRoutePostHandler(source: string): boolean {
  return /\bPOST\s*:/.test(source);
}

/**
 * Cookie-authenticated form POST without an Origin guard. Catches routes that
 * import authorized-client helpers (or other session-reaching modules) and POST
 * without `rejectCrossOriginWrite` / the known guarded wrappers.
 */
function formPostMissingOriginCheck(source: string): boolean {
  return (
    declaresRoutePostHandler(source) &&
    usesSessionCookie(source) &&
    !FORM_POST_ORIGIN_GUARDS.test(source)
  );
}

/**
 * Cookie construction outside `serializeHttpOnlyCookie` is blocked twice.
 *
 * The serializer returns a branded value required by the sole header helper,
 * so a plain string fails typecheck. This literal sweep remains defense in depth
 * for constructed cookie values, while the AST header sweep below inspects the
 * argument expression of every direct Set-Cookie append or set. Runtime-composed
 * attributes therefore cannot bypass the guard by avoiding a contiguous token.
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

  // Contiguous attribute literals in source (not runtime-composed tokens).
  const attributeLiteral = /(?:SameSite\s*=|Max-Age\s*=|; HttpOnly\b|"HttpOnly"|'HttpOnly')/;
  if (attributeLiteral.test(source)) return "protective cookie attribute literal";

  return null;
}

function cookieConstructionOffenders(path: string): Array<string> {
  const relativePath = relative(path);
  if (relativePath === "lib/session-cookie.ts") return [];
  const kind = cookieValueConstruction(code(readFileSync(path, "utf8")));
  return kind ? [`${relativePath}: ${kind}`] : [];
}

function cookieHeaderWrites(path: string): Array<string> {
  const relativePath = relative(path);
  return setCookieHeaderWrites(readFileSync(path, "utf8"), relativePath).map(
    (write) => `${relativePath}: ${write.method}(${write.argument})`,
  );
}

function formPostWrites(path: string): Array<string> {
  const relativePath = relative(path);
  const source = code(readFileSync(path, "utf8"));
  return relativePath.startsWith("routes/") &&
    declaresRoutePostHandler(source) &&
    usesSessionCookie(source)
    ? [relativePath]
    : [];
}

function serverFnWriteCoverage(path: string): {
  all: Array<string>;
  sessionReaching: Array<string>;
} {
  const relativePath = relative(path);
  if (!relativePath.startsWith("lib/")) return { all: [], sessionReaching: [] };
  const serverFns = exportedPostServerFns(
    readFileSync(path, "utf8"),
    relativePath,
    SESSION_REACHING_IMPORTS,
  );
  return {
    all: serverFns.map((serverFn) => `${relativePath}#${serverFn.name}`),
    sessionReaching: serverFns.flatMap((serverFn) =>
      serverFn.reachesSession ? [`${relativePath}#${serverFn.name}`] : [],
    ),
  };
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
    const files = sourceFiles(SRC);
    const offenders = files.flatMap(cookieConstructionOffenders);
    const headerWrites = files.flatMap(cookieHeaderWrites);

    expect(offenders).toEqual([]);
    expect(headerWrites).toEqual(["lib/session-cookie.ts: append(cookie)"]);
    expectTypeOf<string>().not.toExtend<SerializedHttpOnlyCookie>();
    expectTypeOf(serializeHttpOnlyCookie).returns.toEqualTypeOf<SerializedHttpOnlyCookie>();
    expect(code(readFileSync(join(SRC, "lib/session.ts"), "utf8"))).toContain(
      "serializeHttpOnlyCookie",
    );
    expect(code(readFileSync(join(SRC, "lib/oauth-state.ts"), "utf8"))).toContain(
      "serializeHttpOnlyCookie",
    );
  });

  it("enumerates every cookie-authenticated panel write surface", () => {
    const files = sourceFiles(SRC);
    const formPosts = files.flatMap(formPostWrites);
    const serverFnCoverage = files.map(serverFnWriteCoverage);
    const serverFnPosts = serverFnCoverage.flatMap((coverage) => coverage.all);
    const sessionReachingServerFnPosts = serverFnCoverage.flatMap(
      (coverage) => coverage.sessionReaching,
    );

    expect(formPosts.sort()).toEqual([...FORM_POST_COOKIE_AUTHENTICATED_WRITES].sort());
    expect(serverFnPosts.length).toBeGreaterThan(0);
    expect(sessionReachingServerFnPosts.sort()).toEqual(serverFnPosts.sort());
  });

  it("flags a form POST that reaches session via authorized-client without Origin check", () => {
    // Permanent negative: the round-4 blind spot — import helper, not loadSession*.
    const probe = `
import { createFileRoute } from "@tanstack/react-router";
import { authorizedFlagsClient } from "#lib/panel-authorized-clients";

export const Route = createFileRoute("/t263r4-probe")({
  server: {
    handlers: {
      POST: async () => {
        const authorized = await authorizedFlagsClient("env_x");
        return new Response(authorized.ok ? "ok" : "no", { status: 200 });
      },
    },
  },
});
`;

    expect(formPostMissingOriginCheck(code(probe))).toBe(true);
    expect(usesSessionCookie(code(probe))).toBe(true);

    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const relativePath = relative(path);
      if (!relativePath.startsWith("routes/")) continue;
      const source = code(readFileSync(path, "utf8"));
      if (formPostMissingOriginCheck(source)) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
