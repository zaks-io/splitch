import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import { serializeFault } from "./serialize-fault.js";

function nativeParserFailure(input = "x\n    at leakprobe"): SyntaxError {
  try {
    JSON.parse(input);
  } catch (error) {
    return error as SyntaxError;
  }
  throw new Error("Expected malformed JSON");
}

describe("deny-by-default fault messages", () => {
  it("withholds every free message, including multiline native parser headers", () => {
    for (const error of [new Error("messagecanary"), nativeParserFailure(), "stringcanary"]) {
      const fault = serializeFault(error);
      expect(fault).toContain("[message withheld]");
      for (const canary of ["messagecanary", "leakprobe", "stringcanary"])
        expect(fault).not.toContain(canary);
    }
    expect(serializeFault(undefined)).toBeUndefined();
  });

  it("emits only validated names", () => {
    for (const name of ["name-canary", "at namecanary\n", "A".repeat(65), "1bad"]) {
      const error = new Error("message");
      error.name = name;
      expect(serializeFault(error)).toContain("Error: [message withheld]");
      expect(serializeFault(error)).not.toContain(name);
    }
    const error = new Error("message");
    error.name = "Domain_Error2";
    expect(serializeFault(error)).toContain("Domain_Error2: [message withheld]");
  });

  it("retains SQL without reading or matching any parameter entries", () => {
    const error = new DrizzleQueryError("select 1 where ? = 1", [1], new Error("D1_ERROR"));
    const params = vi.fn(() => {
      throw new Error("params must not be read");
    });
    Object.defineProperty(error.params, "0", { get: params });
    expect(serializeFault(error)).toContain("Failed query: select 1 where ? = 1");
    expect(params).not.toHaveBeenCalled();
  });

  it("withholds 100 KB parameter echoes before any output cap", () => {
    const canary = `longcanary${"x".repeat(100_000)}`;
    const query = new DrizzleQueryError("select ?", [canary], new Error(`D1_ERROR: ${canary}`));
    const fault = serializeFault(new Error(canary, { cause: query }));
    expect(fault).toContain("select ?");
    expect(fault).toContain("D1_ERROR");
    expect(fault).not.toContain("longcanary");
    expect(new TextEncoder().encode(fault).byteLength).toBeLessThanOrEqual(8192);
  });

  it("never depends on finding a Drizzle child beyond the node budget", () => {
    const canary = "omittedcanary";
    const errors = [
      ...Array.from({ length: 31 }, () => new Error(canary)),
      new DrizzleQueryError("select ?", [canary], new Error(`D1_ERROR: ${canary}`)),
    ];
    const fault = serializeFault(new AggregateError(errors, canary));
    expect(fault).not.toContain(canary);
    expect(fault).toContain("[1 more errors omitted]");
  });

  it("caps generated SQL at 2,000 characters", () => {
    const fault = serializeFault(
      new DrizzleQueryError("s".repeat(2001), [], new Error("D1_ERROR")),
    );
    expect(fault).toContain("s".repeat(2000));
    expect(fault).not.toContain("s".repeat(2001));
  });
});

describe("static D1 diagnostics", () => {
  it.each([
    ["D1_ERROR: Network connection lost.", "Network connection lost"],
    ["D1_ERROR: internal error", "internal error"],
    [
      "D1_ERROR: UNIQUE constraint failed: customer-canary.secret: SQLITE_CONSTRAINT",
      "UNIQUE constraint failed",
    ],
    ["D1_ERROR: FOREIGN KEY constraint failed: customer-canary", "FOREIGN KEY constraint failed"],
    ["D1_ERROR: NOT NULL constraint failed: customer-canary", "NOT NULL constraint failed"],
    ["D1_ERROR: D1 DB is overloaded. customer-canary", "D1 DB is overloaded"],
    [
      "D1_ERROR: D1 DB storage operation exceeded timeout customer-canary",
      "storage operation exceeded timeout",
    ],
    [
      "D1_ERROR: Durable Object reset because its code was updated customer-canary",
      "Durable Object reset because its code was updated",
    ],
  ])("retains only fixed diagnostics from %s", (message, phrase) => {
    const fault = serializeFault(new Error(message));
    expect(fault).toContain("D1_ERROR");
    expect(fault).toContain(phrase);
    expect(fault).not.toContain("customer-canary");
    if (message.includes("SQLITE_CONSTRAINT")) expect(fault).toContain("SQLITE_CONSTRAINT");
  });

  it("withholds a D1 type error's value and a nested parser excerpt", () => {
    const error = new Error("D1_TYPE_ERROR: Type not supported: bindcanary", {
      cause: nativeParserFailure(),
    });
    const fault = serializeFault(error);
    expect(fault).toContain("D1_TYPE_ERROR");
    expect(fault).not.toContain("bindcanary");
    expect(fault).not.toContain("leakprobe");
  });
});

describe("verified stack headers and isolated fields", () => {
  it("removes the entire multiline header before selecting frames", () => {
    const error = new DrizzleQueryError(
      "select ?",
      ["x\n    at paramcanary"],
      nativeParserFailure(),
    );
    const fault = serializeFault(error);
    expect(fault).toContain("serialize-fault.test.ts");
    expect(fault).not.toContain("paramcanary");
    expect(fault).not.toContain("leakprobe");
  });

  it.each(["custom", "mutated"])("withholds a %s stack whose header no longer matches", (kind) => {
    const error = new Error("old message");
    if (kind === "custom") error.stack = "custom stack\n    at customcanary";
    else {
      void error.stack;
      error.message = "new message";
    }
    expect(serializeFault(error)).toContain("[stack withheld]");
    expect(serializeFault(error)).not.toContain("customcanary");
  });

  it("keeps SQL when an unmaterialized lazy stack reads a hostile message getter", () => {
    const error = new DrizzleQueryError("select ?", ["lazycanary"], new Error("D1_ERROR"));
    Object.defineProperty(error, "message", {
      get() {
        throw new TypeError("lazycanary");
      },
    });
    const fault = serializeFault(error);
    expect(fault).toContain("Failed query: select ?");
    expect(fault).toContain("D1_ERROR");
    expect(fault).toContain("message: [unreadable]");
    expect(fault).toContain("stack: [unreadable]");
    expect(fault).not.toContain("fault serialization failed");
    expect(fault).not.toContain("lazycanary");
  });

  it.each(["name", "message", "stack", "query", "cause", "errors"])(
    "isolates an unreadable %s field",
    (field) => {
      const error = new DrizzleQueryError("select ?", [], new Error("D1_ERROR"));
      Object.defineProperty(error, field, {
        get() {
          throw new Error("gettercanary");
        },
      });
      const fault = serializeFault(error);
      expect(fault).toContain(`${field}: [unreadable]`);
      expect(fault).not.toContain("fault serialization failed");
      expect(fault).not.toContain("gettercanary");
      if (field !== "query") expect(fault).toContain("Failed query: select ?");
      if (field !== "cause") expect(fault).toContain("D1_ERROR");
    },
  );
});

describe("bounded depth-first traversal", () => {
  it("contains unexpected internal failures without exposing their messages", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementationOnce(() => {
      throw new TypeError("internalcanary");
    });
    try {
      expect(serializeFault(new Error("message"))).toBe("[fault serialization failed: TypeError]");
    } finally {
      encode.mockRestore();
    }
  });
  it("keeps early complete cause chains before visiting aggregate siblings", () => {
    const members = Array.from(
      { length: 25 },
      () =>
        new Error("wrapper", {
          cause: new DrizzleQueryError(
            "update deliveries set lease_owner = ?",
            ["membercanary"],
            new Error("D1_ERROR"),
          ),
        }),
    );
    const fault = serializeFault(new AggregateError(members, "aggregatecanary"));
    expect(fault).toContain("update deliveries set lease_owner = ?");
    expect(fault).toContain("D1_ERROR");
    expect(fault).toContain("more errors omitted]");
    expect(fault).not.toContain("membercanary");
    expect(fault).not.toContain("aggregatecanary");
  });

  it("terminates cycles and a cause getter that manufactures nodes", () => {
    const error = new Error("circular");
    error.cause = error;
    expect(serializeFault(error)).toContain("[circular error cause]");
    function endless(): Error {
      return Object.defineProperty(new Error("endless"), "cause", { get: endless });
    }
    expect(serializeFault(endless())).toContain("[1 more errors omitted]");
  });

  it("caps UTF-8 output while retaining an omitted count", () => {
    const error = new Error("large stack");
    error.stack += "\n    at unicode (資料.ts:1:1)".repeat(1000);
    const fault = serializeFault(
      new AggregateError(
        Array.from({ length: 40 }, () => error),
        "large",
      ),
    );
    expect(fault).toContain("[fault output truncated]");
    expect(fault).toContain("more errors omitted]");
    expect(fault).not.toContain("\ufffd");
    expect(new TextEncoder().encode(fault).byteLength).toBeLessThanOrEqual(8192);
  });
});
