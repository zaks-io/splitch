import { describe, expect, it } from "vitest";
import { allMcpParityOperationIds, CLI_COMMANDS, findCommand } from "./command-registry.js";
import { longestMatchingCommandPath, parseInvocation } from "./parse-args.js";

describe("cli command parity", () => {
  it("parses apps create into the apps_create command", () => {
    const keys = new Set(CLI_COMMANDS.map((command) => command.path.join("\0")));
    const parsed = parseInvocation([
      "apps",
      "create",
      "--json",
      "--org",
      "org_1",
      "--name",
      "New App",
    ]);
    const matched = longestMatchingCommandPath(parsed.commandPath, keys);
    expect(findCommand(matched)?.operationId).toBe("apps_create");
  });

  it("parses flags create into the flags_create command", () => {
    const keys = new Set(CLI_COMMANDS.map((command) => command.path.join("\0")));
    const parsed = parseInvocation([
      "flags",
      "create",
      "--json",
      "--app",
      "app_1",
      "--key",
      "checkout",
    ]);
    const matched = longestMatchingCommandPath(parsed.commandPath, keys);
    expect(findCommand(matched)?.operationId).toBe("flags_create");
  });

  it("maps every MCP tool operationId to exactly one CLI command path", () => {
    const mcpIds = allMcpParityOperationIds();
    for (const operationId of mcpIds) {
      const command = CLI_COMMANDS.find(
        (entry) => entry.operationId === operationId && entry.kind === "api",
      );
      expect(command, `missing CLI command for ${operationId}`).toBeDefined();
      expect(findCommand(command?.path ?? [])).toEqual(command);
    }
  });

  it("exposes presentation aliases for env-policy and flags verify", () => {
    expect(findCommand(["env-policy", "get"])?.operationId).toBe("environments_get");
    expect(findCommand(["env-policy", "set"])?.operationId).toBe("environments_update");
    expect(findCommand(["flags", "verify"])?.kind).toBe("flags_verify");
  });
});
