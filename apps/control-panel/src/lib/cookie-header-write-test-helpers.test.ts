import { describe, expect, it } from "vitest";
import { setCookieHeaderWrites } from "./cookie-header-write-test-helpers";

describe("Set-Cookie source guard", () => {
  it("finds a runtime-composed append by its argument expression", () => {
    const source = `
const separator = String.fromCharCode(61);
const cookie = "__probe=value; SameSite" + separator + "None";
headers.append("set-cookie", cookie);
`;

    expect(setCookieHeaderWrites(source, "routes/probe.ts")).toEqual([
      { argument: "cookie", method: "append" },
    ]);
  });

  it("finds a direct set by its argument expression", () => {
    const source = `headers.set("Set-Cookie", raw(token));`;

    expect(setCookieHeaderWrites(source, "routes/probe.ts")).toEqual([
      { argument: "raw(token)", method: "set" },
    ]);
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
    expect(setCookieHeaderWrites(source, "routes/probe.ts")).toEqual([
      { argument: "raw(token)", method },
    ]);
  });

  it("refuses a non-literal header name", () => {
    const source = `
const h = new Headers();
h.append(["set", "cookie"].join("-"), raw(token));
`;

    expect(() => setCookieHeaderWrites(source, "routes/probe.ts")).toThrowError(
      'routes/probe.ts: append() has a non-literal header name: ["set", "cookie"].join("-")',
    );
  });

  it("resolves reviewed header-name bindings before classifying them", () => {
    const source = `
import { CONTROL_PANEL_ENVIRONMENT_HEADER } from "@splitch/control-plane-sdk/control-panel-identity";
headers.set(CONTROL_PANEL_ENVIRONMENT_HEADER, environmentId);
`;

    expect(
      setCookieHeaderWrites(source, "lib/probe.ts", {
        headerNameModules: [
          {
            moduleSpecifier: "@splitch/control-plane-sdk/control-panel-identity",
            exports: {
              CONTROL_PANEL_ENVIRONMENT_HEADER: "x-splitch-panel-environment",
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses a SerializedHttpOnlyCookie assertion outside the serializer", () => {
    const source = `appendHttpOnlyCookie(headers, raw(token) as SerializedHttpOnlyCookie);`;

    expect(() => setCookieHeaderWrites(source, "routes/probe.ts")).toThrowError(
      "routes/probe.ts: SerializedHttpOnlyCookie assertion bypasses serializer provenance",
    );
  });
});
