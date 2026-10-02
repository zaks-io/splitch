import { describe, expect, it } from "vitest";
import { type CliCommandDefinition, findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

function requireCommand(path: string[]): CliCommandDefinition {
  const command = findCommand(path);
  if (!command) throw new Error(`no CLI command registered for "${path.join(" ")}"`);
  return command;
}

describe("flag-changes promotion filter", () => {
  it.each([["list"], ["export"]])(
    "forwards --from-environment-id and --to-environment-id on flag-changes %s",
    (action) => {
      const command = requireCommand(["flag-changes", action]);
      const window =
        action === "export"
          ? ["--from", "2026-01-01T00:00:00Z", "--to", "2026-01-02T00:00:00Z"]
          : [];
      const invocation = parseInvocation([
        "flag-changes",
        action,
        "--json",
        "--app",
        "app_cli",
        "--from-environment-id",
        "env_dev",
        "--to-environment-id",
        "env_prod",
        ...window,
      ]);

      const input = buildOperationInput(command, invocation, { appId: "app_cli" });

      expect(input.fromEnvironmentId).toBe("env_dev");
      expect(input.toEnvironmentId).toBe("env_prod");
    },
  );
});
