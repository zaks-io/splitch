import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFormPostSurfaceDiscovery } from "#lib/testing/form-post-surface-test-helpers";
import { sourceProgram } from "#lib/testing/typescript-program-test-helpers";

const TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));
const ROUTE = fileURLToPath(new URL("../../routes/form-post-probe.ts", import.meta.url));
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
import { renamedWrapper } from "../lib/testing/form-post-probe-helper";
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
import { sessionHelper } from "../lib/testing/form-post-probe-helper";
export const route = { handlers: { POST: () => sessionHelper() } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: false, reachesSessionCookie: true },
    ]);
  });

  it("follows a function-valued handler passed to a call", () => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [HELPER]: `export function runHandler(handler: () => void): void { handler(); }`,
      [ROUTE]: `
import { runHandler } from "../lib/testing/form-post-probe-helper";
import { loadSessionFromCookieHeader } from "../lib/testing/form-post-probe-session";
export const route = { handlers: { POST: () => runHandler(loadSessionFromCookieHeader) } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: false, reachesSessionCookie: true },
    ]);
  });

  it.each([
    ["a parenthesized", `(loadSessionFromCookieHeader)`],
    ["an as-asserted", `loadSessionFromCookieHeader as () => void`],
  ])("follows %s function-valued handler argument", (_name, handler) => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [HELPER]: `export function runHandler(handler: () => void): void { handler(); }`,
      [ROUTE]: `
import { runHandler } from "../lib/testing/form-post-probe-helper";
import { loadSessionFromCookieHeader } from "../lib/testing/form-post-probe-session";
export const route = { handlers: { POST: () => runHandler(${handler}) } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: false, reachesSessionCookie: true },
    ]);
  });

  it.each([
    ["quoted", ``, `"POST"`],
    ["computed", `const METHOD = "POST";`, `[METHOD]`],
  ])("classifies a %s POST property", (_name, declaration, property) => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [ROUTE]: `
import { loadSessionFromCookieHeader } from "../lib/testing/form-post-probe-session";
${declaration}
export const route = { handlers: { ${property}: () => loadSessionFromCookieHeader() } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: false, reachesSessionCookie: true },
    ]);
  });

  it("fails loud on a computed handler key with a non-literal string type", () => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [ROUTE]: `
import { loadSessionFromCookieHeader } from "../lib/testing/form-post-probe-session";
const someString: string = "POST";
export const route = { handlers: { [someString]: () => loadSessionFromCookieHeader() } };
`,
    });

    expect(() =>
      discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts"),
    ).toThrowError(
      /routes\/form-post-probe\.ts:4:\d+: computed property name is not statically resolvable: \[someString\]/,
    );
  });

  it("does not count an Origin guard inside an uninvoked closure", () => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [ROUTE]: `
import { rejectCrossOriginWrite } from "../lib/testing/form-post-probe-csrf";
import { loadSessionFromCookieHeader } from "../lib/testing/form-post-probe-session";
export const route = {
  handlers: {
    POST: () => {
      const neverCalled = () => rejectCrossOriginWrite();
      loadSessionFromCookieHeader();
    },
  },
};
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: false, reachesSessionCookie: true },
    ]);
  });

  it("distinguishes a POST that does not reach the session cookie", () => {
    const program = sourceProgram(TSCONFIG, {
      [SESSION]: `export function loadSessionFromCookieHeader(): void {}`,
      [CSRF]: `export function rejectCrossOriginWrite(): void {}`,
      [ROUTE]: `
import { rejectCrossOriginWrite } from "../lib/testing/form-post-probe-csrf";
export const route = { handlers: { POST: () => rejectCrossOriginWrite() } };
`,
    });

    expect(discovery(program).formPostSecurity(ROUTE, "routes/form-post-probe.ts")).toEqual([
      { reachesOriginGuard: true, reachesSessionCookie: false },
    ]);
  });
});

function discovery(program: ReturnType<typeof sourceProgram>) {
  return createFormPostSurfaceDiscovery(program, {
    originGuard: { exportName: "rejectCrossOriginWrite", filePath: CSRF },
    sessionCookieAccessor: { exportName: "loadSessionFromCookieHeader", filePath: SESSION },
  });
}
