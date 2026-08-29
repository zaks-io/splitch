import { describe, expect, it } from "vitest";
import { findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

describe("canonical Environment selector recovery", () => {
  it("passes --by id to Environment-scoped operations", () => {
    const command = findCommand(["flag-config", "get"]);
    const invocation = parseInvocation([
      "flag-config",
      "get",
      "--app",
      "app_cli",
      "--env",
      "env_collision",
      "--by",
      "id",
      "flag_cli",
    ]);

    const input = buildOperationInput(command, invocation, {
      appId: "app_cli",
      environmentId: "env_collision",
    });

    expect(input).toMatchObject({
      appId: "app_cli",
      environmentId: "env_collision",
      flagId: "flag_cli",
      by: "id",
    });
  });
});
