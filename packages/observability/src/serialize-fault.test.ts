import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { serializeFault } from "./serialize-fault.js";

describe("serializeFault", () => {
  it("keeps ordinary error stacks and non-Error causes", () => {
    const cause = new Error("operation failed", { cause: "upstream refused" });
    expect(serializeFault(cause)).toBe(
      `${cause.stack}\nCaused by: non-Error thrown (string): [message withheld]`,
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
    expect(serializeFault(endlessCause())).toContain("more errors omitted]");
  });

  it("returns a safe diagnostic when a cause getter throws", () => {
    const cause = Object.defineProperty(new Error("readable"), "cause", {
      get() {
        throw new Error("unreadable cause");
      },
    });
    expect(serializeFault(cause)).toBe("[fault serialization failed: Error]");
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
    const fault = serializeFault(new Error(`operation failed for ${canary}`, { cause: error }));
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

  it("also removes exact parameter strings from SQL as defense in depth", () => {
    const fault = serializeFault(
      new DrizzleQueryError("select 1 where ? = 1", [1], new Error("D1_ERROR")),
    );
    expect(fault).toContain("select  where ? = ");
    expect(fault).not.toContain("params:");
  });

  it("traverses aggregate members and causes with cycle protection", () => {
    const aggregate = new AggregateError([new Error("member")], "aggregate", {
      cause: new Error("cause"),
    });
    aggregate.errors.push(aggregate);
    const fault = serializeFault(aggregate);
    expect(fault).toContain("Error: [message withheld]");
    expect(fault).not.toContain("Error: cause");
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
    expect(fault).toContain("more errors omitted]");
  });
});

describe("serializeFault message and output policy", () => {
  it("keeps SQL and D1 diagnostics for a 25-member dispatch aggregate with an omitted count", () => {
    const members = Array.from(
      { length: 25 },
      (_, index) =>
        new DrizzleQueryError(
          "update deliveries set lease_owner = ?",
          [`member-canary-${index}`],
          new Error("D1_ERROR: lease update failed"),
        ),
    );
    const fault = serializeFault(
      new AggregateError(members, "25 Cloudflare delivery lease updates failed"),
    );
    expect(fault).toContain("25 Cloudflare delivery lease updates failed");
    expect(fault).toContain("update deliveries set lease_owner = ?");
    expect(fault).toContain("D1_ERROR: lease update failed");
    expect(fault).toContain("[19 more errors omitted]");
    expect(fault).not.toContain("member-canary");
    expect(new TextEncoder().encode(fault).byteLength).toBeLessThanOrEqual(8192);
  });

  it("withholds native parser messages at the root and beneath Drizzle", () => {
    let failure: unknown;
    try {
      JSON.parse("parsecanary-invalid-json");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SyntaxError);
    for (const error of [
      failure,
      new DrizzleQueryError("select ?", ["parsecanary-invalid-json"], failure as Error),
    ]) {
      const fault = serializeFault(error);
      expect(fault).toContain("SyntaxError: [message withheld]");
      expect(fault).not.toContain("parsecanary");
    }
  });

  it("never reads a Drizzle message when rebuilding its identity", () => {
    const error = new DrizzleQueryError("select ?", ["message-canary"], new Error("D1_ERROR"));
    const stack = error.stack;
    Object.defineProperty(error, "stack", { value: stack });
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("message must not be read");
      },
    });
    expect(serializeFault(error)).toContain("Failed query: select ?");
  });

  it("keeps only frames and caps top-level and D1 messages at 500 characters", () => {
    const outer = new Error("o".repeat(501), { cause: new Error(`D1_${"d".repeat(501)}`) });
    outer.stack += "\nnon-frame-stack-canary";
    const fault = serializeFault(outer);
    expect(fault).toContain("o".repeat(500));
    expect(fault).not.toContain("o".repeat(501));
    expect(fault).toContain(`D1_${"d".repeat(497)}`);
    expect(fault).not.toContain("d".repeat(498));
    expect(fault).not.toContain("non-frame-stack-canary");
  });

  it("caps UTF-8 output including the truncation marker", () => {
    const error = new Error("large stack");
    error.stack += "\n    at unicode (資料.ts:1:1)".repeat(1000);
    const fault = serializeFault(error);
    expect(fault).toContain("Error: large stack");
    expect(fault).toContain("[fault output truncated]");
    expect(fault).not.toContain("\ufffd");
    expect(new TextEncoder().encode(fault).byteLength).toBeLessThanOrEqual(8192);
  });

  it("returns a safe diagnostic if parameter conversion fails internally", () => {
    const error = new DrizzleQueryError("select ?", [], new Error("D1_ERROR"));
    void error.stack;
    error.params.push({
      toString() {
        throw new TypeError("internal-failure-canary");
      },
    });
    expect(serializeFault(error)).toBe("[fault serialization failed: TypeError]");
  });
});
