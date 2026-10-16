import { runInNewContext } from "node:vm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import { serializeFault } from "./serialize-fault.js";

const canary = "roundfourprivatecanary";

describe("engine Error frame provenance", () => {
  it.each([null, 42, canary])(
    "withholds stack detail for a primitive thrown value: %j",
    (value) => {
      expect(serializeFault(value)).toContain("[stack withheld]");
      expect(serializeFault(value)).not.toContain(canary);
    },
  );

  it("withholds an assigned stack on a plain object", () => {
    const fault = serializeFault({
      name: "Error",
      message: "ordinary",
      stack: `Error: ordinary\n    at ${canary} (worker.js:1:1)`,
    });
    expect(fault).toContain("[stack withheld]");
    expect(fault).not.toContain(canary);
  });

  it("withholds an empty-message Error with an assigned stack", () => {
    const error = new Error("");
    error.stack = `Error\n    at ${canary} (worker.js:1:1)`;
    expect(serializeFault(error)).toContain("[stack withheld]");
    expect(serializeFault(error)).not.toContain(canary);
  });

  it("stops at the first non-frame after the complete header", () => {
    const error = new Error("ordinary");
    error.stack = `Error: ordinary\n    at codeFrame (worker.js:1:1)\nCaused by: nested\n    at ${canary} (worker.js:2:1)`;
    const fault = serializeFault(error);
    expect(fault).toContain("at codeFrame (worker.js:1:1)");
    expect(fault).not.toContain(canary);
    expect(fault).not.toContain("nested");
  });

  it("accepts an engine Error from another realm", () => {
    const error = runInNewContext("new Error('ordinary')");
    expect(error).not.toBeInstanceOf(Error);
    expect(Object.prototype.toString.call(error)).toBe("[object Error]");
    expect(serializeFault(error)).toContain("at evalmachine.<anonymous>");
    expect(serializeFault(error)).not.toContain("ordinary");
  });
});

describe("Drizzle query identity", () => {
  it("recognizes the pinned class by constructor name despite its generic Error name", () => {
    const error = new DrizzleQueryError("select ?", [canary], new Error("D1_ERROR"));
    expect(error.name).toBe("Error");
    expect(error.constructor.name).toBe("DrizzleQueryError");
    expect(Object.hasOwn(error, "query")).toBe(true);
    expect(Object.hasOwn(error, "params")).toBe(true);
    expect(serializeFault(error)).toContain("Failed query: select ?");
    expect(serializeFault(error)).not.toContain(canary);
  });

  it.each([
    { query: canary, params: [] },
    { name: "DrizzleQueryError", message: "ordinary", query: canary, params: [] },
    JSON.parse(`{"name":"DrizzleQueryError","query":"${canary}","params":[]}`),
  ])("withholds SQL on a non-Error record: %j", (record) => {
    expect(serializeFault(record)).not.toContain("Failed query:");
    expect(serializeFault(record)).not.toContain(canary);
  });

  it("requires own array params on a real Drizzle error", () => {
    const error = new DrizzleQueryError(canary, [], new Error("D1_ERROR"));
    Reflect.deleteProperty(error, "params");
    Object.setPrototypeOf(
      error,
      Object.assign(Object.create(Object.getPrototypeOf(error)), { params: [] }),
    );
    const fault = serializeFault(error);
    expect(fault).toContain("D1_ERROR");
    expect(fault).not.toContain("Failed query:");
    expect(fault).not.toContain(canary);
  });

  it("withholds SQL when either own Drizzle field has the wrong type", () => {
    const params = new DrizzleQueryError(canary, [], new Error("D1_ERROR"));
    Object.defineProperty(params, "params", { value: null });
    const query = new DrizzleQueryError(canary, [], new Error("D1_ERROR"));
    Object.defineProperty(query, "query", { value: 123 });
    for (const error of [params, query]) {
      expect(serializeFault(error)).toContain("D1_ERROR");
      expect(serializeFault(error)).not.toContain("Failed query:");
      expect(serializeFault(error)).not.toContain(canary);
    }
  });

  it("requires an own string query and the Drizzle constructor name", () => {
    const ordinary = Object.assign(new Error("ordinary"), { query: canary, params: [] });
    const inherited = new DrizzleQueryError(canary, [], new Error("D1_ERROR"));
    Reflect.deleteProperty(inherited, "query");
    Object.setPrototypeOf(
      inherited,
      Object.assign(Object.create(Object.getPrototypeOf(inherited)), { query: canary }),
    );
    for (const error of [ordinary, inherited]) {
      expect(serializeFault(error)).not.toContain("Failed query:");
      expect(serializeFault(error)).not.toContain(canary);
    }
  });

  it("never reads query getters on a non-Drizzle value", () => {
    const query = vi.fn(() => canary);
    const record = Object.defineProperty({ params: [] }, "query", { get: query });
    expect(serializeFault(record)).not.toContain(canary);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["constructor", "constructor.name"])("isolates an unreadable %s", (field) => {
    const error = new DrizzleQueryError("select ?", [canary], new Error("D1_ERROR"));
    const unreadable = () => {
      throw new Error(canary);
    };
    Object.defineProperty(error, "constructor", {
      ...(field === "constructor"
        ? { get: unreadable }
        : { value: Object.defineProperty({}, "name", { get: unreadable }) }),
    });
    const fault = serializeFault(error);
    expect(fault).toContain("constructor.name: [unreadable]");
    expect(fault).toContain("D1_ERROR");
    expect(fault).not.toContain("Failed query:");
    expect(fault).not.toContain("fault serialization failed");
    expect(fault).not.toContain(canary);
  });
});
