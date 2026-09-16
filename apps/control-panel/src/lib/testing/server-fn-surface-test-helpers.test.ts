import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createServerFnSurfaceDiscovery,
  type ServerFnSurfaceDiscovery,
} from "#lib/testing/server-fn-surface-test-helpers";
import { sourceProgram } from "#lib/testing/typescript-program-test-helpers";

const TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));
const DISPLAY_NAME = "lib/probe.ts";

function fixture(fileName: string) {
  return fileURLToPath(new URL(`./${fileName}`, import.meta.url));
}

const exportedAndUnexported = fixture("probe-exported-and-unexported.ts");
const namespaceImports = fixture("probe-namespace-imports.ts");
const assignedWithoutDeclarator = fixture("probe-assigned-without-declarator.ts");
const functionScoped = fixture("probe-function-scoped.ts");
const symbolAliases = fixture("probe-symbol-aliases.ts");
const destructuredAlias = fixture("probe-destructured-alias.ts");
const reexport = fixture("probe-reexport.ts");
const reexportModule = fixture("zz-reexport.ts");
const omittedMethod = fixture("probe-omitted-method.ts");
const unresolvableCallee = fixture("probe-unresolvable-callee.ts");
const unresolvableConstantMethod = fixture("probe-unresolvable-constant-method.ts");
const unresolvableSpreadOptions = fixture("probe-unresolvable-spread-options.ts");
const unresolvableShorthandMethod = fixture("probe-unresolvable-shorthand-method.ts");
const unresolvableIdentifierOptions = fixture("probe-unresolvable-identifier-options.ts");

const FIXTURES: Readonly<Record<string, string>> = {
  [exportedAndUnexported]: `
import { createServerFn as serverFn } from "@tanstack/react-start";

export const direct = serverFn({ method: "POST" }).handler(async () => true);
const local = serverFn({ method: "POST" }).handler(async () => true);
const hidden = serverFn({ method: "POST" }).handler(async () => true);
const read = serverFn({ method: "GET" }).handler(async () => true);
export { local as renamed, read };
export default serverFn({ method: "POST" }).handler(async () => true);
`,
  [namespaceImports]: `
import * as start from "@tanstack/react-start";

export const namespaced = start.createServerFn({ method: "POST" }).handler(async () => true);
`,
  [assignedWithoutDeclarator]: `
import * as start from "@tanstack/react-start";

let assigned;
assigned = start.createServerFn({ method: "POST" }).handler(async () => true);
export { assigned };
`,
  [functionScoped]: `
import { createServerFn } from "@tanstack/react-start";

export function makeNestedProbe() {
  const nested = createServerFn({ method: "POST" }).handler(async () => true);
  return nested;
}
`,
  [symbolAliases]: `
import { createServerFn } from "@tanstack/react-start";
import * as start from "@tanstack/react-start";

const serverFn = createServerFn;
const member = start.createServerFn;
export const localAlias = serverFn({ method: "POST" }).handler(async () => true);
export const memberAlias = member({ method: "POST" }).handler(async () => true);
`,
  [destructuredAlias]: `
import * as start from "@tanstack/react-start";

const { createServerFn } = start;
export const destructured = createServerFn({ method: "POST" }).handler(async () => true);
`,
  [reexport]: `
import { createServerFn } from "./zz-reexport";
export const reexported = createServerFn({ method: "POST" }).handler(async () => true);
`,
  [reexportModule]: `export { createServerFn } from "@tanstack/react-start";`,
  [omittedMethod]: `
import { createServerFn } from "@tanstack/react-start";
export const noOptions = createServerFn().handler(async () => true);
export const noMethod = createServerFn({ strict: true }).handler(async () => true);
`,
  [unresolvableCallee]: `
import { createServerFn } from "@tanstack/react-start";
let serverFn: typeof createServerFn;
serverFn = createServerFn;
export const probe = serverFn({ method: "POST" }).handler(async () => true);
`,
  [unresolvableConstantMethod]: `
import { createServerFn } from "@tanstack/react-start";
const POST_METHOD = "POST" as const; export const probe = createServerFn({ method: POST_METHOD });
`,
  [unresolvableSpreadOptions]: `
import { createServerFn } from "@tanstack/react-start";
const POST_OPTIONS = { method: "POST" } as const; export const probe = createServerFn({ ...POST_OPTIONS });
`,
  [unresolvableShorthandMethod]: `
import { createServerFn } from "@tanstack/react-start";
const method = "POST" as const; export const probe = createServerFn({ method });
`,
  [unresolvableIdentifierOptions]: `
import { createServerFn } from "@tanstack/react-start";
const POST_OPTIONS = { method: "POST" } as const; export const probe = createServerFn(POST_OPTIONS);
`,
};

let discovery: ServerFnSurfaceDiscovery;

beforeAll(() => {
  // One program for the file: per-case createProgram sat near vitest's 5s
  // default under runner contention and timed out hosted Verify.
  discovery = createServerFnSurfaceDiscovery(sourceProgram(TSCONFIG, FIXTURES));
});

describe("POST server function surface discovery", () => {
  it("finds exported and unexported bindings", () => {
    expect(discover(exportedAndUnexported).sort()).toEqual([
      "default",
      "direct",
      "hidden",
      "renamed",
    ]);
  });

  it("finds namespace imports", () => {
    expect(discover(namespaceImports)).toEqual(["namespaced"]);
  });

  it("refuses a server function assigned without a variable declarator", () => {
    expect(() => discover(assignedWithoutDeclarator)).toThrowError(
      'lib/probe.ts: createServerFn POST is not assigned to a statically reviewable binding: "start.createServerFn({ method: \\"POST\\" })"',
    );
  });

  it("finds a function-scoped binding", () => {
    expect(discover(functionScoped)).toEqual(["nested"]);
  });

  it("derives local and namespace-member aliases from symbol identity", () => {
    expect(discover(symbolAliases).sort()).toEqual(["localAlias", "memberAlias"]);
  });

  it("derives a destructured namespace alias from symbol identity", () => {
    expect(discover(destructuredAlias)).toEqual(["destructured"]);
  });

  it("follows createServerFn through a re-export", () => {
    expect(discover(reexport)).toEqual(["reexported"]);
  });

  it("treats an omitted method as GET", () => {
    expect(discover(omittedMethod)).toEqual([]);
  });

  it("refuses a createServerFn-typed callee without a static initializer", () => {
    expect(() => discover(unresolvableCallee)).toThrowError(
      'lib/probe.ts: createServerFn callee is not statically resolvable: "serverFn({ method: \\"POST\\" })"',
    );
  });

  it.each([
    ["constant method", unresolvableConstantMethod, `createServerFn({ method: POST_METHOD })`],
    ["spread options", unresolvableSpreadOptions, `createServerFn({ ...POST_OPTIONS })`],
    ["shorthand method", unresolvableShorthandMethod, `createServerFn({ method })`],
    ["identifier options", unresolvableIdentifierOptions, `createServerFn(POST_OPTIONS)`],
  ] as const)("refuses an unresolvable %s", (_name, entry, call) => {
    expect(() => discover(entry)).toThrowError(
      `lib/probe.ts: createServerFn() method is not statically resolvable: ${JSON.stringify(call)}`,
    );
  });
});

function discover(entry: string) {
  return discovery.postServerFns(entry, DISPLAY_NAME);
}
