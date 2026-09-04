import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, type CliCommandDefinition } from "./command-registry.js";
import { requiredPositionals } from "./command-positionals.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

// Wrangler-backed commands shell out; every other command is exercised.
const COMMANDS = CLI_COMMANDS.filter((command) => !command.kind.startsWith("cloudflare_"));

/**
 * An empty bounded read satisfies the shared list envelope, so list commands see
 * a well-formed response. Commands expecting a resource see an out-of-contract
 * one and take their failure path, which is the half of the contract that used
 * to append a usage block or a second document to the same stdout.
 */
const EMPTY_LIST = { items: [], readLimit: 200, readTruncated: false, cursor: null };

function transportFor(outcome: "ok" | "error"): FakeCliTransport {
  return new FakeCliTransport([
    {
      match: () => true,
      status: outcome === "ok" ? 200 : 500,
      body: outcome === "ok" ? EMPTY_LIST : jsonError("INTERNAL_SERVER_ERROR", "stub failure"),
    },
  ]);
}

type Outcome = "ok" | "error" | "missing-positional";

function argvFor(command: CliCommandDefinition, outcome: Outcome): string[] {
  const positionals =
    outcome === "missing-positional"
      ? []
      : requiredPositionals(command).map((_, index) => `positional_${index}`);
  return [
    ...command.path,
    "--json",
    "--app",
    "app_1",
    "--env",
    "env_1",
    "--targeting-key",
    "user_1",
    ...positionals,
  ];
}

async function stdoutOf(command: CliCommandDefinition, outcome: Outcome): Promise<string> {
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const transport = transportFor(outcome === "error" ? "error" : "ok");
    await runCli(argvFor(command, outcome), { credentialPath, fetch: transport.fetch });
    return log.mock.calls.flat().join("\n");
  } finally {
    vi.restoreAllMocks();
  }
}

describe("--json stdout is one JSON document per command", () => {
  it("covers every non-wrangler command", () => {
    expect(COMMANDS.length).toBeGreaterThan(80);
  });

  for (const outcome of ["ok", "error"] as const) {
    it.each(COMMANDS.map((command) => [command.path.join(" "), command] as const))(
      `%s (${outcome}) writes stdout jq can parse`,
      async (_name, command) => {
        const stdout = await stdoutOf(command, outcome);

        // `jq` reads the whole stream, so trailing prose or a second object is
        // as broken as malformed JSON. Parsing the join proves neither happened.
        expect(stdout).not.toBe("");
        expect(() => JSON.parse(stdout)).not.toThrow();
      },
    );
  }

  // The usage block appended after the failure object is what `jq` choked on.
  it.each(
    COMMANDS.filter((command) => requiredPositionals(command).length > 0).map(
      (command) => [command.path.join(" "), command] as const,
    ),
  )("%s without its positionals writes stdout jq can parse", async (_name, command) => {
    const stdout = await stdoutOf(command, "missing-positional");

    expect(stdout).not.toBe("");
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
