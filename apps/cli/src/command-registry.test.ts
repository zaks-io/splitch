import { routeRegistry } from "@splitch/sdk/control-plane";
import { describe, expect, it } from "vitest";
import {
  allMcpParityOperationIds,
  CLI_COMMANDS,
  commandSupportsConfirm,
  findCommand,
} from "./command-registry.js";
import { renderCommandHelp } from "./help.js";
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

  it("derives orgs create from the route registry (SPL-171)", () => {
    const keys = new Set(CLI_COMMANDS.map((command) => command.path.join("\0")));
    const parsed = parseInvocation(["orgs", "create", "--json", "--name", "Acme Inc"]);
    const matched = longestMatchingCommandPath(parsed.commandPath, keys);

    const command = findCommand(matched);
    expect(command?.operationId).toBe("organizations_create");
    // No :orgId and no :appId in the path, so the CLI must not demand either.
    expect(command?.needsApp).toBe(false);
    expect(command?.needsEnvironment).toBe(false);
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
      "--variants",
      "on,off",
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

  it("derives the Organization usage read command from the shared route", () => {
    expect(findCommand(["organization-usage", "get"])).toMatchObject({
      operationId: "organization_usage_get",
      needsApp: false,
      needsEnvironment: false,
      kind: "api",
    });
  });

  it("exposes presentation aliases for env-policy and flags verify", () => {
    expect(findCommand(["env-policy", "get"])?.operationId).toBe("environments_get");
    expect(findCommand(["env-policy", "set"])?.operationId).toBe("environments_update");
    expect(findCommand(["flags", "verify"])?.kind).toBe("flags_verify");
  });

  it("wires --confirm on every APPROVAL_REVIEW_REQUIRED operation except DELETE (SPL-455)", () => {
    const approvalReviewRequired = new Set(
      routeRegistry
        .filter((route) => route.errors.includes("APPROVAL_REVIEW_REQUIRED"))
        .map((route) => route.operationId),
    );
    // DELETE carries no body, so --confirm cannot send an inline review. The
    // handler hardcodes inlineReview: false; the Approval idempotency key is
    // the header the registrar already requires.
    const confirmExempt = ["flags_delete", "flag_variants_delete"] as const;
    expect([...confirmExempt]).toEqual(["flags_delete", "flag_variants_delete"]);

    const expectedConfirm = new Set(
      [...approvalReviewRequired].filter(
        (operationId) => !confirmExempt.includes(operationId as (typeof confirmExempt)[number]),
      ),
    );
    const actualConfirm = new Set(
      CLI_COMMANDS.filter((command) => command.kind === "api" && command.supportsConfirm).map(
        (command) => command.operationId,
      ),
    );
    expect(actualConfirm).toEqual(expectedConfirm);
    for (const operationId of expectedConfirm) {
      expect(commandSupportsConfirm(operationId)).toBe(true);
    }
    for (const operationId of confirmExempt) {
      expect(commandSupportsConfirm(operationId)).toBe(false);
    }
  });

  it("documents the two-step approval path on each DELETE exemption (SPL-455)", () => {
    const exemptCommands = [
      findCommand(["flags", "delete"]),
      findCommand(["flag-variants", "delete"]),
    ];
    for (const command of exemptCommands) {
      expect(command).toBeDefined();
      if (!command) continue;
      const help = renderCommandHelp(command);
      expect(help).toContain("This DELETE route does not accept --confirm");
      expect(help).toContain("DELETE carries no request body");
      expect(help).toContain("splitch approval-requests list");
      expect(help).toContain(
        'splitch approval-request-reviews create <id> --body-json \'{"action":"approve_and_apply"}\'',
      );
    }
  });
});
