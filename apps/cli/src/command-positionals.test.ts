import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, findCommand, type CliCommandDefinition } from "./command-registry.js";
import {
  commandUsageLine,
  conflictingSuppliedPositional,
  missingRequiredPositional,
  requiredPositionalSpecs,
  requiredPositionals,
} from "./command-positionals.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { renderCommandHelp } from "./help.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

/** Keep gate-path runCli calls hermetic even if the gate is mutated away. */
async function hermeticCliDeps(): Promise<{
  credentialPath: string;
  fetch: typeof fetch;
}> {
  const { credentialPath } = await makeTempHome();
  return {
    credentialPath,
    fetch: async () => {
      throw new Error("network must not be reached from positional-gate tests");
    },
  };
}

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
    const code = await runCli([...command.path], await hermeticCliDeps());

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
    const code = await runCli(
      ["runs", "list", "--app", "app_1", "--env", "env_1", "--body-json", "{}"],
      await hermeticCliDeps(),
    );

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
});

describe("mixed path-param sources on multi-positional routes (SPL-306)", () => {
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
    expect(conflictingSuppliedPositional(command, invocation)).toBeUndefined();

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

  it.each(
    MULTI_POSITIONAL_PATHS.map((path) => ({ path: path.join(" "), segments: path })),
  )("positional colliding with --body-json field is CLI_USAGE_INVALID for $path", ({
    segments,
  }) => {
    const command = requireCommand(segments);
    const specs = requiredPositionalSpecs(command);
    const [first, second] = specs;
    if (!first || !second) {
      throw new Error(`expected two path params for ${segments.join(" ")}`);
    }

    const invocation = parseInvocation([
      ...segments,
      "--body-json",
      JSON.stringify({ [first.param]: "from_body" }),
      "from_argv_first",
      "from_argv_second",
    ]);

    expect(conflictingSuppliedPositional(command, invocation)).toEqual({
      kind: "conflict",
      display: first.display,
    });
    expect(() =>
      buildOperationInput(command, invocation, { appId: "app_1", environmentId: "env_1" }),
    ).toThrowError(
      expect.objectContaining({
        code: "CLI_USAGE_INVALID",
        causeSummary: expect.stringContaining(`<${first.display}> was supplied more than once`),
      }),
    );
  });

  it.each(
    (["organization-members update", "organization-members remove"] as const).map((path) => ({
      path,
      segments: path.split(" ") as [string, string],
    })),
  )("--org plus both positionals is CLI_USAGE_INVALID for $path", ({ segments }) => {
    const command = requireCommand(segments);
    const specs = requiredPositionalSpecs(command);
    expect(specs[0]?.param).toBe("orgId");

    const invocation = parseInvocation([...segments, "--org", "org_1", "org_1", "user_1"]);

    expect(conflictingSuppliedPositional(command, invocation)).toEqual({
      kind: "conflict",
      display: "org-id",
    });
    expect(() => buildOperationInput(command, invocation, {})).toThrowError(
      expect.objectContaining({
        code: "CLI_USAGE_INVALID",
        causeSummary: expect.stringContaining("<org-id> was supplied more than once"),
      }),
    );
  });
});

describe("unexpected excess positionals (SPL-306)", () => {
  it("names the unexpected token on a multi-positional command, not a double supply", async () => {
    const command = requireCommand(["organization-members", "remove"]);
    const invocation = parseInvocation([
      "organization-members",
      "remove",
      "org_1",
      "user_1",
      "extra_1",
    ]);

    expect(conflictingSuppliedPositional(command, invocation)).toEqual({
      kind: "unexpected",
      token: "extra_1",
    });
    expect(() => buildOperationInput(command, invocation, {})).toThrowError(
      expect.objectContaining({
        code: "CLI_USAGE_INVALID",
        causeSummary: expect.stringContaining("Unexpected argument extra_1"),
        remediation: expect.stringContaining("Remove extra_1"),
      }),
    );
    expect(conflictingSuppliedPositional(command, invocation)?.kind).not.toBe("conflict");

    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(" "));
    });

    const code = await runCli(
      ["organization-members", "remove", "org_1", "user_1", "extra_1"],
      await hermeticCliDeps(),
    );
    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("CLI_USAGE_INVALID");
    expect(errorLine).toContain("Unexpected argument extra_1");
    expect(errorLine).not.toContain("supplied more than once");
    expect(errorLine).not.toContain("Usage:");
    expect(stdout.join("\n")).toContain(`Usage:\n  ${commandUsageLine(command)}`);
  });

  it("names the unexpected token on a zero-positional command with a Usage block", async () => {
    const command = requireCommand(["flags", "list"]);
    expect(requiredPositionalSpecs(command)).toEqual([]);

    const invocation = parseInvocation(["flags", "list", "extra_1"]);
    expect(conflictingSuppliedPositional(command, invocation)).toEqual({
      kind: "unexpected",
      token: "extra_1",
    });

    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(" "));
    });

    const code = await runCli(["flags", "list", "extra_1"], await hermeticCliDeps());
    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("CLI_USAGE_INVALID");
    expect(errorLine).toContain("Unexpected argument extra_1");
    expect(errorLine).not.toContain("supplied more than once");
    expect(errorLine).not.toContain("<argument>");
    expect(errorLine).not.toContain("Usage:");
    expect(stdout.join("\n")).toContain(`Usage:\n  ${commandUsageLine(command)}`);
  });

  it("treats orgs create with a stray positional as unexpected, not double supply", async () => {
    const command = requireCommand(["orgs", "create"]);
    expect(requiredPositionalSpecs(command)).toEqual([]);

    const invocation = parseInvocation(["orgs", "create", "acme", "--name", "x"]);
    expect(conflictingSuppliedPositional(command, invocation)).toEqual({
      kind: "unexpected",
      token: "acme",
    });

    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(" "));
    });

    const code = await runCli(["orgs", "create", "acme", "--name", "x"], await hermeticCliDeps());
    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("Unexpected argument acme");
    expect(errorLine).not.toContain("supplied more than once");
    expect(stdout.join("\n")).toContain(`Usage:\n  ${commandUsageLine(command)}`);
  });
});

describe("malformed --body-json in the positional gate (SPL-306)", () => {
  it("names malformed --body-json instead of a wrong missing argument", async () => {
    const command = requireCommand(["organization-members", "update"]);
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(" "));
    });

    const code = await runCli(
      ["organization-members", "update", "--body-json", '{"orgId":"org_1"', "user_1"],
      await hermeticCliDeps(),
    );

    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("CLI_USAGE_INVALID");
    expect(errorLine).toContain("Malformed --body-json");
    expect(errorLine).not.toContain("Missing required argument");
    expect(errorLine).not.toContain("<user-id>");
    expect(stdout.join("\n")).toContain(`Usage:\n  ${commandUsageLine(command)}`);
  });

  it("rejects --body-json as a Flag key source for flags verify", async () => {
    const command = requireCommand(["flags", "verify"]);
    expect(
      missingRequiredPositional(
        command,
        parseInvocation([
          "flags",
          "verify",
          "--targeting-key",
          "user-1",
          "--body-json",
          JSON.stringify({ flagKey: "checkout" }),
        ]),
      ),
    ).toBe("flag-key");

    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(
      [
        "flags",
        "verify",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "--targeting-key",
        "user-1",
        "--body-json",
        JSON.stringify({ flagKey: "checkout" }),
      ],
      await hermeticCliDeps(),
    );

    expect(code).toBe(EXIT_USAGE);
    const errorLine = stderr.join("\n");
    expect(errorLine).toContain("Missing required argument <flag-key>");
    expect(errorLine).not.toContain("CLI_UNEXPECTED_ERROR");
  });
});
