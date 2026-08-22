import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCookieHeaderWriteDiscovery } from "./cookie-header-write-test-helpers";
import { sourceProgram } from "./typescript-program-test-helpers";

const TSCONFIG = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));

describe("Set-Cookie source guard", () => {
  it("finds a runtime-composed append by its argument expression", () => {
    const source = `
const separator = String.fromCharCode(61);
const cookie = "__probe=value; SameSite" + separator + "None";
const headers = new Headers();
headers.append("set-cookie", cookie);
`;

    expect(discover(source)).toEqual([{ argument: "cookie", method: "append" }]);
  });

  it("finds a direct set by its argument expression", () => {
    const source = `const headers = new Headers(); headers.set("Set-Cookie", raw(token));`;

    expect(discover(source)).toEqual([{ argument: "raw(token)", method: "set" }]);
  });

  it.each([
    [
      "Headers record",
      `new Headers({ "cache-control": "no-store", "set-cookie": raw(token) });`,
      "property",
    ],
    ["Headers pairs", `new Headers([["set-cookie", raw(token)]]);`, "entry"],
    [
      "Response headers record",
      `new Response(null, { headers: { "Set-Cookie": raw(token) }, status: 302 });`,
      "property",
    ],
  ] as const)("finds a Set-Cookie write in %s form", (_name, source, method) => {
    expect(discover(source)).toEqual([{ argument: "raw(token)", method }]);
  });

  it("finds a Headers-typed parameter regardless of its name", () => {
    const source = `
export function writeCookie(jar: Headers, raw: string): void {
  jar.append("set-cookie", raw);
}
`;

    expect(discover(source)).toEqual([{ argument: "raw", method: "append" }]);
  });

  it.each(["jar", "headers"])("finds an optional Headers receiver named %s", (receiverName) => {
    const source = `
export function writeCookie(${receiverName}: Headers | undefined, raw: string): void {
  ${receiverName}?.append("set-cookie", raw);
}
`;

    expect(discover(source)).toEqual([{ argument: "raw", method: "append" }]);
  });

  it("ignores an optional Headers receiver that does not write Set-Cookie", () => {
    const source = `
export function writeCacheHeader(jar: Headers | undefined): void {
  jar?.append("cache-control", "no-store");
}
`;

    expect(discover(source)).toEqual([]);
  });

  it("refuses a computed header-record property name", () => {
    const source = `
const SET_COOKIE = "set-cookie";
new Response(null, { headers: { [SET_COOKIE]: raw(token) } });
`;

    expect(() => discover(source)).toThrowError(
      "routes/probe.ts: header property name is not statically resolvable: [SET_COOKIE]: raw(token)",
    );
  });

  it("refuses a computed header-entry name", () => {
    const source = `
const SET_COOKIE = "set-cookie";
new Response(null, { headers: [[SET_COOKIE, raw(token)]] });
`;

    expect(() => discover(source)).toThrowError(
      "routes/probe.ts: header entry name is not statically resolvable: [SET_COOKIE, raw(token)]",
    );
  });

  it("refuses a spread header-entry source", () => {
    const source = `
const pairs = new Map<string, string>([["set-cookie", raw(token)]]);
new Response(null, { headers: [...pairs] });
`;

    expect(() => discover(source)).toThrowError(
      "routes/probe.ts: header entry source is not statically resolvable: ...pairs",
    );
  });

  it("refuses a non-literal header name", () => {
    const source = `
const h = new Headers();
h.append(["set", "cookie"].join("-"), raw(token));
`;

    expect(() => discover(source)).toThrowError(
      'routes/probe.ts: append() has a non-literal header name: ["set", "cookie"].join("-")',
    );
  });

  it("finds the Start response-header setter imported by name", () => {
    const source = `
import { setResponseHeader as setHeader } from "@tanstack/react-start/server";
setHeader("set-cookie", raw(token));
`;

    expect(discover(source)).toEqual([{ argument: "raw(token)", method: "setResponseHeader" }]);
  });

  it("refuses a namespace import of the Start response-header setter", () => {
    const source = `
import * as start from "@tanstack/react-start/server";
start.setResponseHeader("set-cookie", raw(token));
`;

    expect(() => discover(source)).toThrowError(
      "routes/probe.ts: namespace import of @tanstack/react-start/server hides setResponseHeader() calls from the Set-Cookie sweep; import it by name",
    );
  });

  it("refuses a header-mutating receiver whose type is unresolved", () => {
    const source = `declare const jar: any; jar.append("set-cookie", raw(token));`;

    expect(() => discover(source)).toThrowError(
      "routes/probe.ts: append() receiver type is not statically resolvable: jar",
    );
  });

  it("ignores a non-header set call on an unresolved receiver", () => {
    const source = `declare const someMap: any; someMap.set("probe", "value");`;

    expect(discover(source)).toEqual([]);
  });

  it("resolves reviewed header-name bindings before classifying them", () => {
    const source = `
import { CONTROL_PANEL_ENVIRONMENT_HEADER } from "@splitch/control-plane-sdk/control-panel-identity";
const headers = new Headers();
headers.set(CONTROL_PANEL_ENVIRONMENT_HEADER, environmentId);
`;

    expect(
      discover(source, [
        {
          moduleSpecifier: "@splitch/control-plane-sdk/control-panel-identity",
          exports: {
            CONTROL_PANEL_ENVIRONMENT_HEADER: "x-splitch-panel-environment",
          },
        },
      ]),
    ).toEqual([]);
  });

  it("refuses a SerializedHttpOnlyCookie assertion outside the serializer", () => {
    const source = `appendHttpOnlyCookie(headers, raw(token) as SerializedHttpOnlyCookie);`;

    expect(() => discover(source)).toThrowError(
      "routes/probe.ts: SerializedHttpOnlyCookie assertion bypasses serializer provenance",
    );
  });
});

function discover(
  source: string,
  headerNameModules: ReadonlyArray<{
    exports: Readonly<Record<string, string>>;
    moduleSpecifier: string;
  }> = [],
) {
  const entry = fileURLToPath(new URL("./cookie-probe.ts", import.meta.url));
  const program = sourceProgram(TSCONFIG, { [entry]: source });
  return createCookieHeaderWriteDiscovery(program, { headerNameModules }).setCookieHeaderWrites(
    entry,
    "routes/probe.ts",
  );
}
