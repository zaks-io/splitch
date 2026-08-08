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
});
