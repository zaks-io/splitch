import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { serializeFault } from "./serialize-fault.js";

describe("serializeFault", () => {
  it("keeps ordinary error stacks and non-Error causes", () => {
    const cause = new Error("operation failed", { cause: "upstream refused" });
    expect(serializeFault(cause)).toBe(
      `${cause.stack}\nCaused by: non-Error thrown (string): upstream refused`,
    );
    expect(serializeFault(undefined)).toBeUndefined();
  });

  it("terminates cyclic cause chains", () => {
    const cause = new Error("circular");
    cause.cause = cause;
    expect(serializeFault(cause)).toBe(`${cause.stack}\nCaused by: [circular error cause]`);
  });

  it("bounds a cause getter that manufactures new errors", () => {
    function endlessCause(): Error {
      return Object.defineProperty(new Error("endless"), "cause", { get: endlessCause });
    }
    expect(serializeFault(endlessCause())).toContain("[error cause chain truncated]");
  });

  it("keeps readable identity when a cause getter throws", () => {
    const cause = Object.defineProperty(new Error("readable"), "cause", {
      get() {
        throw new Error("unreadable cause");
      },
    });
    expect(serializeFault(cause)).toContain(cause.stack);
    expect(serializeFault(cause)).toContain("unrepresentable");
  });

  it("omits unsafe nonstandard Drizzle stacks and still reports the database cause", () => {
    const cause = new DrizzleQueryError(
      "select ?",
      ["bound-parameter-canary"],
      new Error("D1_ERROR"),
    );
    cause.stack = `nonstandard stack: ${cause.message}`;
    const fault = serializeFault(cause);
    expect(fault).toContain("select ?");
    expect(fault).toContain("D1_ERROR");
    expect(fault).not.toContain("bound-parameter-canary");
  });
});
