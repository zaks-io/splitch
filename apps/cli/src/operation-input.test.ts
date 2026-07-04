import { describe, expect, it } from "vitest";
import { findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

describe("buildOperationInput", () => {
  it("flags update keeps explicit appId and flagId over --body-json route overrides", () => {
    const command = findCommand(["flags", "update"]);
    expect(command).toBeDefined();
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

    const input = buildOperationInput(command!, invocation, { appId: "app_flag" });

    expect(input.appId).toBe("app_flag");
    expect(input.flagId).toBe("flag_pos");
    expect(input.name).toBe("Renamed");
  });

  it("flag-config update keeps explicit appId, environmentId, and flagId over --body-json", () => {
    const command = findCommand(["flag-config", "update"]);
    expect(command).toBeDefined();
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

    const input = buildOperationInput(command!, invocation, {
      appId: "app_cli",
      environmentId: "env_cli",
    });

    expect(input.appId).toBe("app_cli");
    expect(input.environmentId).toBe("env_cli");
    expect(input.flagId).toBe("flag_cli");
    expect(input.enabled).toBe(true);
  });

  it("flags promote keeps explicit target environment over --body-json", () => {
    const command = findCommand(["flags", "promote"]);
    expect(command).toBeDefined();
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

    const input = buildOperationInput(command!, invocation, {
      appId: "app_cli",
      environmentId: "env_target",
    });

    expect(input.appId).toBe("app_cli");
    expect(input.targetEnvironmentId).toBe("env_target");
    expect(input.flagId).toBe("flag_cli");
    expect(input.fromEnvironmentId).toBe("env_source");
  });
});
