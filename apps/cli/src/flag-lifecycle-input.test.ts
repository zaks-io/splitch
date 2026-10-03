import { describe, expect, it } from "vitest";
import { applyFlagLifecycleFlags } from "./flag-lifecycle-input.js";
import { parseInvocation } from "./parse-args.js";

function flagsOf(args: string[]) {
  return parseInvocation(args).flags;
}

describe("applyFlagLifecycleFlags", () => {
  it("passes the lifecycle flags through on flags create", () => {
    const input: Record<string, unknown> = {};
    applyFlagLifecycleFlags(
      "flags_create",
      flagsOf(["--lifecycle-class", "release", "--owner", "team", "--expires-at", "2027-01-01"]),
      input,
    );
    expect(input).toEqual({ lifecycleClass: "release", owner: "team", expiresAt: "2027-01-01" });
  });

  it("turns none into a clear on flags update", () => {
    const input: Record<string, unknown> = {};
    applyFlagLifecycleFlags(
      "flags_update",
      flagsOf(["--owner", "none", "--expires-at", "none"]),
      input,
    );
    expect(input).toEqual({ owner: null, expiresAt: null });
  });

  it("refuses none on flags create, where there is nothing to clear", () => {
    expect(() => applyFlagLifecycleFlags("flags_create", flagsOf(["--owner", "none"]), {})).toThrow(
      /only applies to flags update/,
    );
  });

  it("refuses lifecycle flags on any other command", () => {
    expect(() =>
      applyFlagLifecycleFlags("flags_get", flagsOf(["--lifecycle-class", "ops"]), {}),
    ).toThrow(/apply only to flags create and flags update/);
  });

  it("leaves input untouched when no lifecycle flag is given", () => {
    const input: Record<string, unknown> = { name: "x" };
    applyFlagLifecycleFlags("flags_get", flagsOf([]), input);
    expect(input).toEqual({ name: "x" });
  });
});
