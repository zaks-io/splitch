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
  it("flags update keeps context appId and positional flagId over --body-json appId", () => {
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
        name: "Renamed",
      }),
    ]);

    const input = buildOperationInput(command, invocation, { appId: "app_flag" });

    expect(input.appId).toBe("app_flag");
    expect(input.flagId).toBe("flag_pos");
    expect(input.name).toBe("Renamed");
  });

  it("flag-config update keeps context ids and positional flagId over --body-json scope fields", () => {
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

  it("flags promote keeps context target environment and positional flagId over --body-json", () => {
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

describe("path-param double supply", () => {
  it("rejects a positional that collides with --body-json flagId", () => {
    const command = requireCommand(["flags", "update"]);
    expect(() =>
      buildOperationInput(
        command,
        parseInvocation([
          "flags",
          "update",
          "--app",
          "app_flag",
          "flag_pos",
          "--body-json",
          JSON.stringify({ flagId: "flag_body", name: "Renamed" }),
        ]),
        { appId: "app_flag" },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CLI_USAGE_INVALID",
        causeSummary: expect.stringContaining("<flag-id-or-key> was supplied more than once"),
      }),
    );
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

  it("approval-requests list forwards optional --env as environmentId filter", () => {
    const command = requireCommand(["approval-requests", "list"]);
    expect(command.needsEnvironment).toBe(false);

    const withEnv = buildOperationInput(
      command,
      parseInvocation([
        "approval-requests",
        "list",
        "--json",
        "--app",
        "app_cli",
        "--env",
        "env_prod",
      ]),
      { appId: "app_cli", environmentId: "env_prod", environmentSource: "flag" },
    );
    expect(withEnv).toMatchObject({ appId: "app_cli", environmentId: "env_prod" });

    const withoutEnv = buildOperationInput(
      command,
      parseInvocation(["approval-requests", "list", "--json", "--app", "app_cli"]),
      { appId: "app_cli" },
    );
    expect(withoutEnv.environmentId).toBeUndefined();
  });

  it("approval-requests list ignores config and SPLITCH_ENV without --env", () => {
    const command = requireCommand(["approval-requests", "list"]);
    const fromConfig = buildOperationInput(
      command,
      parseInvocation(["approval-requests", "list", "--json", "--app", "app_cli"]),
      { appId: "app_cli", environmentId: "env_prod", environmentSource: "config" },
    );
    expect(fromConfig.environmentId).toBeUndefined();

    const fromSplitchEnv = buildOperationInput(
      command,
      parseInvocation(["approval-requests", "list", "--json", "--app", "app_cli"]),
      { appId: "app_cli", environmentId: "env_prod", environmentSource: "env" },
    );
    expect(fromSplitchEnv.environmentId).toBeUndefined();
  });

  it("flags list stays app-scoped and does not forward environmentId", () => {
    const command = requireCommand(["flags", "list"]);
    const input = buildOperationInput(
      command,
      parseInvocation(["flags", "list", "--json", "--app", "app_cli", "--env", "env_prod"]),
      { appId: "app_cli", environmentId: "env_prod", environmentSource: "flag" },
    );
    expect(input).toEqual({ appId: "app_cli" });
  });
});
