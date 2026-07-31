import { describe, expect, it } from "vitest";
import { type CliCommandDefinition, findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

function requireCommand(path: string[]): CliCommandDefinition {
  const command = findCommand(path);
  if (!command) throw new Error(`no CLI command registered for "${path.join(" ")}"`);
  return command;
}

describe("buildOperationInput", () => {
  it("flags update keeps explicit appId and flagId over --body-json route overrides", () => {
    const command = requireCommand(["flags", "update"]);
    const invocation = parseInvocation([
      "flags",
      "update",
      "--json",
      "--app",
      "app_flag",
      "flag_pos",
      "--body-json",
      JSON.stringify({
        appId: "app_body",
        flagId: "flag_body",
        name: "Renamed",
      }),
    ]);

    const input = buildOperationInput(command, invocation, { appId: "app_flag" });

    expect(input.appId).toBe("app_flag");
    expect(input.flagId).toBe("flag_pos");
    expect(input.name).toBe("Renamed");
  });

  it("flag-config update keeps explicit appId, environmentId, and flagId over --body-json", () => {
    const command = requireCommand(["flag-config", "update"]);
    const invocation = parseInvocation([
      "flag-config",
      "update",
      "--json",
      "--app",
      "app_cli",
      "--env",
      "env_cli",
      "flag_cli",
      "--enabled",
      "true",
      "--body-json",
      JSON.stringify({
        appId: "app_body",
        environmentId: "env_body",
        flagId: "flag_body",
        enabled: false,
      }),
    ]);

    const input = buildOperationInput(command, invocation, {
      appId: "app_cli",
      environmentId: "env_cli",
    });

    expect(input.appId).toBe("app_cli");
    expect(input.environmentId).toBe("env_cli");
    expect(input.flagId).toBe("flag_cli");
    expect(input.enabled).toBe(true);
    expect(input.idempotency_key).toEqual(expect.stringMatching(/^cli_/));
  });

  it("parses --enabled false as a boolean false", () => {
    const command = findCommand(["flag-config", "update"]);
    const invocation = parseInvocation([
      "flag-config",
      "update",
      "--app",
      "app_cli",
      "--env",
      "env_cli",
      "flag_cli",
      "--enabled",
      "false",
    ]);

    const input = buildOperationInput(command, invocation, {
      appId: "app_cli",
      environmentId: "env_cli",
    });

    expect(input.enabled).toBe(false);
  });

  it("rejects a non-boolean --enabled value instead of silently disabling", () => {
    expect(() =>
      parseInvocation([
        "flag-config",
        "update",
        "--app",
        "app_cli",
        "--env",
        "env_cli",
        "flag_cli",
        "--enabled",
        "TRUE",
      ]),
    ).toThrowError(expect.objectContaining({ code: "CLI_USAGE_INVALID" }));
  });

  it("flags promote keeps explicit target environment over --body-json", () => {
    const command = requireCommand(["flags", "promote"]);
    const invocation = parseInvocation([
      "flags",
      "promote",
      "--json",
      "--app",
      "app_cli",
      "--env",
      "env_target",
      "flag_cli",
      "--from-environment-id",
      "env_source",
      "--body-json",
      JSON.stringify({
        appId: "app_body",
        targetEnvironmentId: "env_body",
        flagId: "flag_body",
        fromEnvironmentId: "env_body_source",
      }),
    ]);

    const input = buildOperationInput(command, invocation, {
      appId: "app_cli",
      environmentId: "env_target",
    });

    expect(input.appId).toBe("app_cli");
    expect(input.targetEnvironmentId).toBe("env_target");
    expect(input.flagId).toBe("flag_cli");
    expect(input.fromEnvironmentId).toBe("env_source");
  });
});

describe("canonical approval input", () => {
  it("keeps an explicit --idempotency-key stable", () => {
    const command = requireCommand(["flag-config", "update"]);
    const invocation = parseInvocation([
      "flag-config",
      "update",
      "--app",
      "app_cli",
      "--env",
      "env_cli",
      "--idempotency-key",
      "idem_user_selected",
      "flag_cli",
      "--enabled",
      "true",
    ]);

    const input = buildOperationInput(command, invocation, {
      appId: "app_cli",
      environmentId: "env_cli",
    });

    expect(input.idempotency_key).toBe("idem_user_selected");
  });

  it("maps --confirm to the canonical inline review", () => {
    const command = requireCommand(["experiments", "start"]);
    const invocation = parseInvocation([
      "experiments",
      "start",
      "--confirm",
      "--app",
      "app_cli",
      "--env",
      "env_cli",
      "experiment_cli",
    ]);

    const input = buildOperationInput(command, invocation, {
      appId: "app_cli",
      environmentId: "env_cli",
    });

    expect(input.review).toEqual({ action: "approve_and_apply" });
    expect(input.confirm).toBeUndefined();
    expect(input.idempotency_key).toEqual(expect.stringMatching(/^cli_/));
  });
});
