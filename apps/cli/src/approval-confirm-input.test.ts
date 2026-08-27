import { describe, expect, it } from "vitest";
import { type CliCommandDefinition, findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

function requireCommand(path: string[]): CliCommandDefinition {
  const command = findCommand(path);
  if (!command) throw new Error(`no CLI command registered for "${path.join(" ")}"`);
  return command;
}

describe("SPL-455 --confirm on body approval operations", () => {
  it("maps --confirm on flag-variants create", () => {
    const command = requireCommand(["flag-variants", "create"]);
    expect(command.supportsConfirm).toBe(true);
    const invocation = parseInvocation([
      "flag-variants",
      "create",
      "--confirm",
      "--app",
      "app_cli",
      "flag_cli",
      "--name",
      "treatment-b",
      "--body-json",
      '{"value":true}',
    ]);

    const input = buildOperationInput(command, invocation, { appId: "app_cli" });

    expect(input.review).toEqual({ action: "approve_and_apply" });
    expect(input.flagId).toBe("flag_cli");
    expect(input.name).toBe("treatment-b");
    expect(input.value).toBe(true);
  });

  it("maps --confirm on segments update", () => {
    const command = requireCommand(["segments", "update"]);
    expect(command.supportsConfirm).toBe(true);
    const invocation = parseInvocation([
      "segments",
      "update",
      "--confirm",
      "--app",
      "app_cli",
      "seg_cli",
      "--name",
      "enterprise",
    ]);

    const input = buildOperationInput(command, invocation, { appId: "app_cli" });

    expect(input.review).toEqual({ action: "approve_and_apply" });
    expect(input.segmentId).toBe("seg_cli");
    expect(input.name).toBe("enterprise");
  });
});
