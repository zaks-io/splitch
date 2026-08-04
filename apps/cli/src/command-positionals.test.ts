import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, findCommand } from "./command-registry.js";
import {
  commandUsageLine,
  missingRequiredPositional,
  requiredPositionalSpecs,
  requiredPositionals,
} from "./command-positionals.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { renderCommandHelp } from "./help.js";
import { parseInvocation } from "./parse-args.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every registered command that documents at least one required positional. */
const COMMANDS_WITH_REQUIRED_POSITIONALS = CLI_COMMANDS.filter(
  (command) => requiredPositionals(command).length > 0,
);

describe("required positionals (SPL-306)", () => {
  it("registers at least one command with a required positional in each major group", () => {
    const groups = new Set(
      COMMANDS_WITH_REQUIRED_POSITIONALS.map((command) => command.path[0]).filter(Boolean),
    );
    // Representative coverage across command groups — a newly added required
    // positional on any command is covered by the table below.
    expect(groups.has("runs")).toBe(true);
    expect(groups.has("flags")).toBe(true);
    expect(groups.has("experiments")).toBe(true);
    expect(groups.has("apps")).toBe(true);
    expect(COMMANDS_WITH_REQUIRED_POSITIONALS.length).toBeGreaterThan(10);
  });

  it("keeps help usage lines identical to the shared usage helper", () => {
    for (const command of CLI_COMMANDS) {
      const help = renderCommandHelp(command);
      expect(help).toContain(`Usage:\n  ${commandUsageLine(command)}`);
    }
  });

  it.each(
    COMMANDS_WITH_REQUIRED_POSITIONALS.map((command) => ({
      path: command.path.join(" "),
      command,
      missing: requiredPositionals(command)[0] ?? "",
      usage: commandUsageLine(command),
    })),
  )("returns CLI_USAGE_INVALID when omitting positionals for $path", async ({
    command,
    missing,
    usage,
  }) => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(" "));
    });

    // Omit every required positional. No credentials or scope flags — misuse
    // must fail as usage before any control-plane-sdk path build.
    const code = await runCli([...command.path]);

    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("CLI_USAGE_INVALID");
    expect(errorLine).toContain(`Missing required argument <${missing}>`);
    expect(errorLine).toContain(usage);
    expect(errorLine).not.toContain("CLI_UNEXPECTED_ERROR");
    expect(errorLine).not.toContain("control-plane-sdk");
    expect(errorLine).not.toContain("missing path param");
    expect(stdout.join("\n")).toContain(`Usage:\n  ${usage}`);
  });

  it("does not let a body-json-only omission leak an SDK path-param error", async () => {
    const runsList = CLI_COMMANDS.find(
      (command) => command.path[0] === "runs" && command.path[1] === "list",
    );
    if (!runsList) {
      throw new Error("runs list is not registered");
    }
    expect(requiredPositionalSpecs(runsList).map((spec) => spec.param)).toEqual(["experimentId"]);

    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Empty --body-json must still fail as usage before control-plane-sdk throws
    // its internal missing-path-param Error (and before auth/scope).
    const code = await runCli([
      "runs",
      "list",
      "--app",
      "app_1",
      "--env",
      "env_1",
      "--body-json",
      "{}",
    ]);

    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("CLI_USAGE_INVALID");
    expect(errorLine).toContain("Missing required argument <experiment-id>");
    expect(errorLine).not.toContain("CLI_UNEXPECTED_ERROR");
    expect(errorLine).not.toContain("control-plane-sdk");
    expect(errorLine).not.toContain("missing path param");
  });

  it("accepts --org in place of the <org-id> positional for apps create", () => {
    // Quickstart documents `apps create --org <orgId>`; that must not become a
    // false usage error now that positionals are validated.
    const command = findCommand(["apps", "create"]);
    if (!command) {
      throw new Error("apps create is not registered");
    }
    expect(
      missingRequiredPositional(
        command,
        parseInvocation(["apps", "create", "--org", "org_1", "--name", "New App"]),
      ),
    ).toBeUndefined();
  });
});
