import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOAuthState, OAUTH_STATE_COOKIE_NAME } from "./oauth-state";
import { createSession, SESSION_COOKIE_NAME } from "./session";
import { PANEL_COOKIE_PROTECTIVE_ATTRIBUTES, serializeHttpOnlyCookie } from "./session-cookie";
import { MemoryKv, NOW, sessionPrincipal } from "./session-test-harness";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Cookie-authenticated panel writes that ride the session cookie.
 *
 * Form POSTs have no CSRF token and no TanStack Origin check — they rest on
 * `SameSite=Lax` alone (see `session-cookie.ts`). `createServerFn` POSTs get
 * TanStack's Origin/Sec-Fetch-Site middleware in addition, but still depend on
 * the same cookie attributes if that layer is disabled or bypassed.
 *
 * Adding a new surface here is the review gate: update this list in the same
 * change that introduces the write, and re-read the CSRF comment in
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

/** Session is loaded in-file or via the shared authorized-* client helpers. */
function usesSessionCookie(source: string): boolean {
  return /loadSessionFromRequest|authorizedFlagsClient|authorizedApprovalsClient/.test(source);
}

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

function assertProtectiveAttributes(cookie: string, label: string): void {
  for (const attribute of PANEL_COOKIE_PROTECTIVE_ATTRIBUTES) {
    expect(
      cookie,
      `${label}: weakening ${attribute} removes the panel CSRF/session protection`,
    ).toContain(attribute);
  }
  expect(cookie, `${label}: SameSite=None would make every panel write forgeable`).not.toMatch(
    /SameSite=None/i,
  );
}

describe("panel cookie protective attributes are the CSRF mechanism", () => {
  it("pins SameSite=Lax HttpOnly Secure Path=/ on the shared serializer", () => {
    const cookie = serializeHttpOnlyCookie("__probe", "value", { maxAge: 60 });

    assertProtectiveAttributes(cookie, "serializeHttpOnlyCookie");
    expect(PANEL_COOKIE_PROTECTIVE_ATTRIBUTES).toEqual([
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
    ]);
  });

  it("applies the same attributes to every cookie the panel sets", async () => {
    const kv = new MemoryKv();
    const session = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    const oauth = await createOAuthState(kv.namespace(), "/", NOW);

    assertProtectiveAttributes(session.cookie, SESSION_COOKIE_NAME);
    assertProtectiveAttributes(oauth.cookie, OAUTH_STATE_COOKIE_NAME);
  });

  it("builds every Set-Cookie value through serializeHttpOnlyCookie", () => {
    const offenders: string[] = [];
    // Attribute assignments only — function names like serializeHttpOnlyCookie
    // contain the substring and are not attribute literals. Call sites that
    // append a pre-serialized `cookie` string to the Set-Cookie header are fine.
    const attributeLiteral = /(?:SameSite\s*=|Max-Age\s*=|; HttpOnly\b|"HttpOnly"|'HttpOnly')/;

    for (const path of sourceFiles(SRC)) {
      const relativePath = relative(path);
      if (relativePath === "lib/session-cookie.ts") continue;

      const source = code(readFileSync(path, "utf8"));
      if (attributeLiteral.test(source)) {
        offenders.push(`${relativePath}: cookie attribute literal outside serializeHttpOnlyCookie`);
      }
    }

    expect(offenders).toEqual([]);
    // Session and OAuth state are the only cookies; both call the shared serializer.
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

      if (
        /createServerFn\(\{\s*method:\s*"POST"\s*\}\)/.test(source) &&
        usesSessionCookie(source)
      ) {
        serverFnPosts.push(relativePath);
      }
    }

    expect(formPosts.sort()).toEqual([...FORM_POST_COOKIE_AUTHENTICATED_WRITES].sort());
    expect(serverFnPosts.sort()).toEqual([...CREATE_SERVER_FN_POST_WRITES].sort());
  });
});
