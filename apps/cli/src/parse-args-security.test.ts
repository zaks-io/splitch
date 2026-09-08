import { describe, expect, it } from "vitest";
import { parseInvocation } from "./parse-args";

describe("CLI singleton flags", () => {
  it.each([
    ["--app", "app_1", "--app", "app_2"],
    ["--body-json", "{}", "--body-json", "{}"],
    ["--idempotency-key", "one", "--idempotency-key", "two"],
    ["--confirm", "--confirm"],
  ])("rejects a duplicate singleton flag", (...flags) => {
    expect(() => parseInvocation(["flags", "create", ...flags])).toThrowError(
      expect.objectContaining({ code: "CLI_USAGE_INVALID" }),
    );
  });

  it("retains ordered repeatable --when flags", () => {
    const invocation = parseInvocation([
      "flag-targeting-rules",
      "add",
      "--when",
      "plan=pro",
      "--when",
      "region=us",
    ]);
    expect(invocation.flags.when).toEqual(["plan=pro", "region=us"]);
  });
});
