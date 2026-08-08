import { describe, expect, it } from "vitest";
import { exportedPostServerFns } from "./server-fn-surface-test-helpers";

describe("POST server function surface discovery", () => {
  it("finds direct, separately exported, aliased, and default exports", () => {
    const source = `
import { createServerFn as serverFn } from "@tanstack/react-start";

export const direct = serverFn({ method: "POST" }).handler(async () => true);
const local = serverFn({ method: "POST" }).handler(async () => true);
const read = serverFn({ method: "GET" }).handler(async () => true);
export { local as renamed, read };
export default serverFn({ method: "POST" }).handler(async () => true);
`;

    expect(exportedPostServerFns(source, "components/probe.tsx").sort()).toEqual([
      "default",
      "direct",
      "renamed",
    ]);
  });

  it("finds namespace imports and separately assigned exports", () => {
    const source = `
import * as start from "@tanstack/react-start";

export const namespaced = start.createServerFn({ method: "POST" }).handler(async () => true);
let assigned;
assigned = start.createServerFn({ method: "POST" }).handler(async () => true);
export { assigned as renamedAssignment };
`;

    expect(exportedPostServerFns(source, "components/probe.tsx").sort()).toEqual([
      "namespaced",
      "renamedAssignment",
    ]);
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

    expect(() => exportedPostServerFns(source, "lib/probe.ts")).toThrowError(
      `lib/probe.ts: createServerFn() method is not statically resolvable: ${JSON.stringify(call)}`,
    );
  });
});
