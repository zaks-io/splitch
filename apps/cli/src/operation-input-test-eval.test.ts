import { describe, expect, it } from "vitest";
import { findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

const command = findCommand(["flags", "test-eval"]);
const context = { appId: "app_cli", environmentId: "env_cli" };

describe("test evaluation identity types", () => {
  it("defaults an omitted identity type to user", () => {
    const input = buildOperationInput(
      command,
      parseInvocation(["flags", "test-eval", "checkout", "--targeting-key", "user-1"]),
      context,
    );

    expect(input.evaluationContext).toMatchObject({ idType: "user" });
  });

  it.each([
    ["an explicit null", null],
    ["an uppercase value", "User"],
    ["a hyphenated value", "user-type"],
  ])("rejects %s from --body-json", (_label, idType) => {
    expect(() =>
      buildOperationInput(
        command,
        parseInvocation([
          "flags",
          "test-eval",
          "checkout",
          "--body-json",
          JSON.stringify({ evaluationContext: { targetingKey: "user-1", idType, attributes: {} } }),
        ]),
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "CLI_USAGE_INVALID" }));
  });

  it("rejects a typo-shaped --id-type", () => {
    expect(() =>
      buildOperationInput(
        command,
        parseInvocation([
          "flags",
          "test-eval",
          "checkout",
          "--targeting-key",
          "user-1",
          "--id-type",
          "user-type",
        ]),
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "CLI_USAGE_INVALID" }));
  });
});
