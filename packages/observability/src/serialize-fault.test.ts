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

  it("redacts parameters echoed by ancestors and nested database causes", () => {
    const canary = "echoed-bound-canary";
    const query = "select ? from apps";
    const error = new DrizzleQueryError(
      query,
      [canary],
      new Error(`D1_ERROR: rejected value ${canary}`),
    );
    const fault = serializeFault(new Error(`operation failed: ${error.message}`, { cause: error }));
    expect(fault).toContain(query);
    expect(fault).toContain("D1_ERROR: rejected value");
    expect(fault).not.toContain(canary);
    expect(fault).not.toContain("params:");
  });

  it("redacts every repeated Drizzle message in the retained stack", () => {
    const error = new DrizzleQueryError(
      "select ?",
      ["repeated-bound-canary"],
      new Error("D1_ERROR"),
    );
    error.stack += `\nRepeated: ${error.message}\n    at retained-frame`;
    const fault = serializeFault(error);
    expect(fault).toContain("select ?");
    expect(fault).toContain("D1_ERROR");
    expect(fault).toContain("retained-frame");
    expect(fault).not.toContain("repeated-bound-canary");
    expect(fault).not.toContain("params:");
  });

  it("keeps SQL even when a bound value also occurs in the SQL", () => {
    const fault = serializeFault(
      new DrizzleQueryError("select 1 where ? = 1", [1], new Error("D1_ERROR")),
    );
    expect(fault).toContain("select 1 where ? = 1");
    expect(fault).not.toContain("params:");
  });

  it("traverses aggregate members and causes with cycle protection", () => {
    const aggregate = new AggregateError([new Error("member")], "aggregate", {
      cause: new Error("cause"),
    });
    aggregate.errors.push(aggregate);
    const fault = serializeFault(aggregate);
    expect(fault).toContain("Error: member");
    expect(fault).toContain("Error: cause");
    expect(fault).toContain("[circular error cause]");
  });

  it("shares one traversal limit across aggregate members and causes", () => {
    let reads = 0;
    const members = Array.from({ length: 40 }, () =>
      Object.defineProperty(new Error("member"), "cause", {
        get() {
          reads++;
          return new Error("child");
        },
      }),
    );
    const fault = serializeFault(new AggregateError(members, "aggregate"));
    expect(reads).toBeLessThan(32);
    expect(fault).toContain("[error cause chain truncated]");
  });

  it("omits ancestor text when the traversal limit hides its query parameters", () => {
    const canary = "unvisited-bound-canary";
    const members = Array.from({ length: 32 }, () => new Error("member"));
    members.push(new DrizzleQueryError("select ?", [canary], new Error("D1_ERROR")));
    const fault = serializeFault(new AggregateError(members, `query failed for ${canary}`));
    expect(fault).toBe("[error cause chain truncated]");
  });
});
