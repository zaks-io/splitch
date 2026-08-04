import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, findCommand, type CliCommandDefinition } from "./command-registry.js";
import {
  commandUsageLine,
  missingRequiredPositional,
  requiredPositionalSpecs,
  requiredPositionals,
} from "./command-positionals.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { renderCommandHelp } from "./help.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every registered command that documents at least one required positional. */
const COMMANDS_WITH_REQUIRED_POSITIONALS = CLI_COMMANDS.filter(
  (command) => requiredPositionals(command).length > 0,
);

/** Multi-positional routes named by the SPL-306 review for mixed-source coverage. */
const MULTI_POSITIONAL_PATHS = [
  ["runs", "get"],
  ["flag-variants", "update"],
  ["organization-members", "update"],
  ["organization-members", "remove"],
] as const;

function requireCommand(path: readonly string[]): CliCommandDefinition {
  const command = findCommand(path);
  if (!command) {
    throw new Error(`no CLI command registered for "${path.join(" ")}"`);
  }
  return command;
}

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
    expect(errorLine).toContain(`Pass <${missing}>`);
    // Usage lives only in the stdout block — not embedded in remediation.
    expect(errorLine).not.toContain("Usage:");
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
    expect(errorLine).not.toContain("Usage:");
    expect(errorLine).not.toContain("CLI_UNEXPECTED_ERROR");
    expect(errorLine).not.toContain("control-plane-sdk");
    expect(errorLine).not.toContain("missing path param");
  });

  it("accepts --org in place of the <org-id> positional for apps create", () => {
    // Quickstart documents `apps create --org <orgId>`; that must not become a
    // false usage error now that positionals are validated.
    const command = requireCommand(["apps", "create"]);
    expect(
      missingRequiredPositional(
        command,
        parseInvocation(["apps", "create", "--org", "org_1", "--name", "New App"]),
      ),
    ).toBeUndefined();
  });

  describe("mixed body-json + argv on multi-positional routes", () => {
    it.each(
      MULTI_POSITIONAL_PATHS.map((path) => ({ path: path.join(" "), segments: path })),
    )("first via --body-json plus second via argv succeeds for $path", ({ segments }) => {
      const command = requireCommand(segments);
      const specs = requiredPositionalSpecs(command);
      expect(specs.length).toBeGreaterThanOrEqual(2);
      const [first, second] = specs;
      if (!first || !second) {
        throw new Error(`expected two path params for ${segments.join(" ")}`);
      }

      const invocation = parseInvocation([
        ...segments,
        "--body-json",
        JSON.stringify({ [first.param]: "from_body" }),
        "from_argv",
      ]);

      expect(missingRequiredPositional(command, invocation)).toBeUndefined();

      const input = buildOperationInput(command, invocation, {
        appId: "app_1",
        environmentId: "env_1",
      });
      expect(input[first.param]).toBe("from_body");
      expect(input[second.param]).toBe("from_argv");
    });

    it.each(
      MULTI_POSITIONAL_PATHS.map((path) => ({ path: path.join(" "), segments: path })),
    )("first via argv plus second omitted names the second for $path", ({ segments }) => {
      const command = requireCommand(segments);
      const specs = requiredPositionalSpecs(command);
      expect(specs.length).toBeGreaterThanOrEqual(2);
      const second = specs[1];
      if (!second) {
        throw new Error(`expected a second path param for ${segments.join(" ")}`);
      }

      expect(missingRequiredPositional(command, parseInvocation([...segments, "only_first"]))).toBe(
        second.display,
      );
    });
  });
});
