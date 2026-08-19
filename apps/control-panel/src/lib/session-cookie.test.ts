import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  CONTROL_PANEL_ENVIRONMENT_HEADER,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createCookieHeaderWriteDiscovery } from "./cookie-header-write-test-helpers";
import { createFormPostSurfaceDiscovery } from "./form-post-surface-test-helpers";
import { createOAuthState, OAUTH_STATE_COOKIE_NAME } from "./oauth-state";
import { createServerFnSurfaceDiscovery } from "./server-fn-surface-test-helpers";
import { createSession, SESSION_COOKIE_NAME } from "./session";
import {
  PANEL_COOKIE_ATTRIBUTES,
  type SerializedHttpOnlyCookie,
  serializeHttpOnlyCookie,
} from "./session-cookie";
import { MemoryKv, NOW, sessionPrincipal } from "./session-test-harness";
import { projectProgram } from "./typescript-program-test-helpers";

const SRC = fileURLToPath(new URL("..", import.meta.url));
// The sweep tests walk every source file through the type checker; the walk
// grows with the tree and already exceeds the 5s default under CI load.
const SWEEP_TIMEOUT_MS = 30_000;
const HEADER_NAME_MODULES = [
  {
    moduleSpecifier: "@splitch/control-plane-sdk/control-panel-identity",
    exports: {
      CONTROL_PANEL_DELEGATION_HEADER,
      CONTROL_PANEL_ENVIRONMENT_HEADER,
    },
  },
] as const;
const SOURCE_PROGRAM = projectProgram(join(SRC, "..", "tsconfig.json"));
const SERVER_FN_SURFACE = createServerFnSurfaceDiscovery(SOURCE_PROGRAM);
const COOKIE_HEADER_WRITES = createCookieHeaderWriteDiscovery(SOURCE_PROGRAM, {
  headerNameModules: HEADER_NAME_MODULES,
});
const FORM_POST_SURFACE = createFormPostSurfaceDiscovery(SOURCE_PROGRAM, {
  originGuard: {
    exportName: "rejectCrossOriginWrite",
    filePath: join(SRC, "lib/panel-csrf.ts"),
  },
  sessionCookieAccessor: {
    exportName: "loadSessionFromCookieHeader",
    filePath: join(SRC, "lib/session.ts"),
  },
});

/**
 * Cookie-authenticated panel writes that ride the session cookie.
 *
 * Form POSTs require same-origin Origin (`panel-csrf.ts`) — SameSite=Lax alone
 * is a site boundary and insufficient across *.splitch.dev. createServerFn
 * POSTs require TanStack CSRF middleware from `src/start.ts`.
 *
 * Both inventories are reviewed surfaces. The createServerFn inventory walks
 * every source file. Form discovery starts from statically named POST properties
 * declared in route source files, then follows checker-resolved calls and
 * function-valued call arguments to the session accessor and Origin guard.
 * Unresolvable computed property names fail discovery at their source position.
 * Imported or spread handler objects and runtime-dispatched function values
 * remain outside that sweep. createServerFn POSTs are identified by file and
 * exported or local binding, so a new write in an existing file moves the
 * discovered side of the equality.
 */
const FORM_POST_COOKIE_AUTHENTICATED_WRITES = [
  "routes/auth.logout.ts",
  "routes/claim.consent.$attemptId.tsx",
] as const;

const CREATE_SERVER_FN_POST_WRITES = [
  "lib/claim-ceremony-functions.ts#submitClaimCeremony",
  "lib/control-plane-app-functions.ts#createControlPanelApp",
  "lib/control-plane-experiment-functions.ts#createControlPanelExperiment",
  "lib/control-plane-experiment-functions.ts#stageAndStartControlPanelExperimentRun",
  "lib/control-plane-experiment-functions.ts#updateControlPanelExperiment",
  "lib/control-plane-flag-functions.ts#createControlPanelFlag",
  "lib/control-plane-flag-mutations.ts#editControlPanelTargetingRules",
  "lib/control-plane-flag-mutations.ts#loadControlPanelApprovalRequest",
  "lib/control-plane-flag-mutations.ts#promoteControlPanelFlagConfig",
  "lib/control-plane-flag-mutations.ts#reviewControlPanelApprovalRequest",
  "lib/control-plane-flag-mutations.ts#updateControlPanelFlagConfig",
  "lib/control-plane-metric-functions.ts#deleteControlPanelMetric",
  "lib/control-plane-metric-functions.ts#saveControlPanelMetric",
  "lib/control-plane-org-member-functions.ts#addControlPanelOrgMember",
  "lib/control-plane-org-member-functions.ts#removeControlPanelOrgMember",
  "lib/control-plane-org-member-functions.ts#updateControlPanelOrgMemberRole",
  "lib/control-plane-organization-functions.ts#createControlPanelOrganization",
  "lib/control-plane-segment-functions.ts#deleteControlPanelSegment",
  "lib/control-plane-segment-functions.ts#saveControlPanelSegment",
  "lib/control-plane-settings-functions.ts#lockControlPanelClientKey",
  "lib/control-plane-settings-functions.ts#provisionControlPanelApiKey",
  "lib/control-plane-settings-functions.ts#revokeControlPanelApiKey",
  "lib/control-plane-settings-functions.ts#updateControlPanelEnvironmentPolicy",
  "lib/control-plane-verify-functions.ts#verifyControlPanelFlag",
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
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

/**
 * Cookie construction outside `serializeHttpOnlyCookie` has two independent
 * source guards, pinned by executable probes in
 * `cookie-header-write-test-helpers.test.ts`.
 *
 * The literal sweep finds contiguous cookie attributes outside the serializer.
 * The AST sweep finds Set-Cookie append/set calls, Headers records and pairs,
 * Response header records, and plain header properties even when the value is
 * runtime-composed. It resolves the two imported control-plane header names,
 * rejects non-literal names on Headers calls, and rejects computed names or
 * spread sources inside recognized header initializers. Cookie brand assertions
 * outside the serializer also fail. Opaque helper calls remain outside the sweep.
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
  return COOKIE_HEADER_WRITES.setCookieHeaderWrites(path, relativePath, {
    allowSerializedCookieAssertion: relativePath === "lib/session-cookie.ts",
  }).map((write) => `${relativePath}: ${write.method}`);
}

function formPostWrites(path: string): Array<string> {
  const relativePath = relative(path);
  if (!relativePath.startsWith("routes/")) return [];
  return FORM_POST_SURFACE.formPostSecurity(path, relativePath).some(
    (post) => post.reachesSessionCookie,
  )
    ? [relativePath]
    : [];
}

function formPostOriginOffenders(path: string): Array<string> {
  const relativePath = relative(path);
  if (!relativePath.startsWith("routes/")) return [];
  return FORM_POST_SURFACE.formPostSecurity(path, relativePath).some(
    (post) => post.reachesSessionCookie && !post.reachesOriginGuard,
  )
    ? [relativePath]
    : [];
}

function serverFnWrites(path: string): Array<string> {
  const relativePath = relative(path);
  return SERVER_FN_SURFACE.postServerFns(path, relativePath).map(
    (serverFn) => `${relativePath}#${serverFn}`,
  );
}

describe("panel cookie attributes", () => {
  it("pins the exact serializer output including host-only (no Domain)", () => {
    const cookie = serializeHttpOnlyCookie("__probe", "value", { maxAge: 60 });

    expect(cookie).toBe("__probe=value; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60");
    expect(PANEL_COOKIE_ATTRIBUTES).toEqual(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]);
  });

  it("applies the same attributes to every cookie the panel sets", async () => {
    const kv = new MemoryKv();
    const session = await createSession(kv.namespace(), sessionPrincipal(), NOW);
    const oauth = await createOAuthState(kv.namespace(), "/", NOW);

    assertCookieAttributes(session.cookie, SESSION_COOKIE_NAME);
    assertCookieAttributes(oauth.cookie, OAUTH_STATE_COOKIE_NAME);
  });

  it("builds every cookie value through serializeHttpOnlyCookie", {
    timeout: SWEEP_TIMEOUT_MS,
  }, () => {
    const files = sourceFiles(SRC);
    const offenders = files.flatMap(cookieConstructionOffenders);
    const headerWrites = files.flatMap(cookieHeaderWrites);

    expect(offenders).toEqual([]);
    expect(headerWrites.sort()).toEqual(["lib/session-cookie.ts: append"]);
    expectTypeOf<string>().not.toExtend<SerializedHttpOnlyCookie>();
    expectTypeOf(serializeHttpOnlyCookie).returns.toEqualTypeOf<SerializedHttpOnlyCookie>();
  });

  it("enumerates every cookie-authenticated panel write surface", {
    timeout: SWEEP_TIMEOUT_MS,
  }, () => {
    const files = sourceFiles(SRC);
    const formPosts = files.flatMap(formPostWrites);
    const serverFnPosts = files.flatMap(serverFnWrites);

    expect(formPosts.sort()).toEqual([...FORM_POST_COOKIE_AUTHENTICATED_WRITES].sort());
    expect(serverFnPosts.sort()).toEqual([...CREATE_SERVER_FN_POST_WRITES].sort());
  });

  it("flags every cookie-authenticated form POST without an Origin check", {
    timeout: SWEEP_TIMEOUT_MS,
  }, () => {
    const offenders = sourceFiles(SRC).flatMap(formPostOriginOffenders);
    expect(offenders).toEqual([]);
  });
});
