import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFormPostSurfaceDiscovery } from "./form-post-surface-test-helpers";
import { sourceProgram } from "./typescript-program-test-helpers";

const TSCONFIG = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
const ROUTE = fileURLToPath(new URL("../routes/form-post-probe.ts", import.meta.url));
const SESSION = fileURLToPath(new URL("./form-post-probe-session.ts", import.meta.url));
const CSRF = fileURLToPath(new URL("./form-post-probe-csrf.ts", import.meta.url));
const HELPER = fileURLToPath(new URL("./form-post-probe-helper.ts", import.meta.url));

describe("form POST surface guard", () => {
  it("resolves session and Origin reachability through an imported wrapper", () => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [HELPER]: `
import { rejectCrossOriginWrite } from "./form-post-probe-csrf";
import { loadSessionFromCookieHeader } from "./form-post-probe-session";
export function renamedWrapper(): void {
  rejectCrossOriginWrite();
  loadSessionFromCookieHeader();
}
`,
      [ROUTE]: `
import { renamedWrapper } from "../lib/form-post-probe-helper";
const POST = () => renamedWrapper();
export const route = { handlers: { POST } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: true, reachesSessionCookie: true },
    ]);
  });

  it("distinguishes an unguarded session-reaching wrapper", () => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [HELPER]: `
import { loadSessionFromCookieHeader } from "./form-post-probe-session";
export function sessionHelper(): void { loadSessionFromCookieHeader(); }
`,
      [ROUTE]: `
import { sessionHelper } from "../lib/form-post-probe-helper";
export const route = { handlers: { POST: () => sessionHelper() } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: false, reachesSessionCookie: true },
    ]);
  });
});

function discovery(program: ReturnType<typeof sourceProgram>) {
  return createFormPostSurfaceDiscovery(program, {
    originGuard: { exportName: "rejectCrossOriginWrite", filePath: CSRF },
    sessionCookieAccessor: { exportName: "loadSessionFromCookieHeader", filePath: SESSION },
  });
}
