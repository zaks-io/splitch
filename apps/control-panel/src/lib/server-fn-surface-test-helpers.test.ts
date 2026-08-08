import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServerFnSurfaceDiscovery } from "./server-fn-surface-test-helpers";
import { sourceProgram } from "./typescript-program-test-helpers";

const TSCONFIG = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));

describe("POST server function surface discovery", () => {
  it("finds exported and unexported bindings", () => {
    const source = `
import { createServerFn as serverFn } from "@tanstack/react-start";

export const direct = serverFn({ method: "POST" }).handler(async () => true);
const local = serverFn({ method: "POST" }).handler(async () => true);
const hidden = serverFn({ method: "POST" }).handler(async () => true);
const read = serverFn({ method: "GET" }).handler(async () => true);
export { local as renamed, read };
export default serverFn({ method: "POST" }).handler(async () => true);
`;

    expect(discover(source).sort()).toEqual(["default", "direct", "hidden", "renamed"]);
  });

  it("finds namespace imports and separately assigned exports", () => {
    const source = `
import * as start from "@tanstack/react-start";

export const namespaced = start.createServerFn({ method: "POST" }).handler(async () => true);
let assigned;
assigned = start.createServerFn({ method: "POST" }).handler(async () => true);
export { assigned as renamedAssignment };
`;

    expect(discover(source).sort()).toEqual(["namespaced", "renamedAssignment"]);
  });

  it("derives local and namespace-member aliases from symbol identity", () => {
    const source = `
import { createServerFn } from "@tanstack/react-start";
import * as start from "@tanstack/react-start";

const serverFn = createServerFn;
const member = start.createServerFn;
export const localAlias = serverFn({ method: "POST" }).handler(async () => true);
export const memberAlias = member({ method: "POST" }).handler(async () => true);
`;

    expect(discover(source).sort()).toEqual(["localAlias", "memberAlias"]);
  });

  it("derives a destructured namespace alias from symbol identity", () => {
    const source = `
import * as start from "@tanstack/react-start";

const { createServerFn } = start;
export const destructured = createServerFn({ method: "POST" }).handler(async () => true);
`;

    expect(discover(source)).toEqual(["destructured"]);
  });

  it("follows createServerFn through a re-export", () => {
    const source = `
import { createServerFn } from "./zz-reexport";
export const reexported = createServerFn({ method: "POST" }).handler(async () => true);
`;
    const reexport = `export { createServerFn } from "@tanstack/react-start";`;

    expect(discover(source, { "zz-reexport.ts": reexport })).toEqual(["reexported"]);
  });

  it("treats an omitted method as GET", () => {
    const source = `
import { createServerFn } from "@tanstack/react-start";
export const noOptions = createServerFn().handler(async () => true);
export const noMethod = createServerFn({ strict: true }).handler(async () => true);
`;

    expect(discover(source)).toEqual([]);
  });

  it("refuses a createServerFn-typed callee without a static initializer", () => {
    const source = `
import { createServerFn } from "@tanstack/react-start";
let serverFn: typeof createServerFn;
serverFn = createServerFn;
export const probe = serverFn({ method: "POST" }).handler(async () => true);
`;

    expect(() => discover(source)).toThrowError(
      'lib/probe.ts: createServerFn callee is not statically resolvable: "serverFn({ method: \\"POST\\" })"',
    );
  });

  it.each([
    [
      "constant method",
      `const POST_METHOD = "POST" as const; export const probe = createServerFn({ method: POST_METHOD });`,
      `createServerFn({ method: POST_METHOD })`,
    ],
    [
      "spread options",
      `const POST_OPTIONS = { method: "POST" } as const; export const probe = createServerFn({ ...POST_OPTIONS });`,
      `createServerFn({ ...POST_OPTIONS })`,
    ],
    [
      "shorthand method",
      `const method = "POST" as const; export const probe = createServerFn({ method });`,
      `createServerFn({ method })`,
    ],
    [
      "identifier options",
      `const POST_OPTIONS = { method: "POST" } as const; export const probe = createServerFn(POST_OPTIONS);`,
      `createServerFn(POST_OPTIONS)`,
    ],
  ] as const)("refuses an unresolvable %s", (_name, declaration, call) => {
    const source = `
import { createServerFn } from "@tanstack/react-start";
${declaration}
`;

    expect(() => discover(source)).toThrowError(
      `lib/probe.ts: createServerFn() method is not statically resolvable: ${JSON.stringify(call)}`,
    );
  });
});

function discover(source: string, supportingSources: Readonly<Record<string, string>> = {}) {
  const entry = fileURLToPath(new URL("./probe.ts", import.meta.url));
  const sources = Object.fromEntries([
    [entry, source],
    ...Object.entries(supportingSources).map(
      ([fileName, contents]) =>
        [fileURLToPath(new URL(`./${fileName}`, import.meta.url)), contents] as const,
    ),
  ]);
  const program = sourceProgram(TSCONFIG, sources);
  return createServerFnSurfaceDiscovery(program).postServerFns(entry, "lib/probe.ts");
}
