import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, META_COMMANDS } from "./command-registry.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { renderCommandHelp, renderHelp, renderMetaHelp, renderRootHelp } from "./help.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("published CLI help", () => {
  it("snapshots the root, every group, and every registered subcommand", () => {
    const groups = [...new Set(CLI_COMMANDS.map((command) => command.path[0]))].sort();
    const help = {
      root: renderRootHelp(),
      groups: Object.fromEntries(
        groups.map((group) => [group, renderHelp([group ?? "", "--help"])]),
      ),
      meta: Object.fromEntries(META_COMMANDS.map((command) => [command, renderMetaHelp(command)])),
      commands: Object.fromEntries(
        CLI_COMMANDS.map((command) => [command.path.join(" "), renderCommandHelp(command)]),
      ),
    };

    expect(help).toMatchSnapshot();
  });

  it("documents every displayed flag with its type and default and gives one example", () => {
    const helpTexts = [
      ...META_COMMANDS.map(renderMetaHelp),
      ...CLI_COMMANDS.map(renderCommandHelp),
    ];

    for (const help of helpTexts) {
      expect(help.match(/^Example:$/gm)).toHaveLength(1);
      const flagLines = help.split("\n").filter((line) => line.startsWith("  -"));
      expect(flagLines.length).toBeGreaterThan(0);
      for (const line of flagLines) {
        expect(line).toMatch(/\[type: .+; default: .+\]/);
      }
    }
  });

  it("pins Flag KEY wording and the Client Key versus API Key boundary", () => {
    const verify = renderHelp(["flags", "verify", "--help"]);
    const flagsGet = renderHelp(["flags", "get", "--help"]);
    const clientKey = renderHelp(["client-key", "get", "--help"]);
    const apiKey = renderHelp(["api-keys", "create", "--help"]);

    expect(verify).toContain("Usage:\n  splitch flags verify <flag-key> [flags]");
    expect(verify).toContain("Verify a Flag KEY");
    expect(flagsGet).toContain("Usage:\n  splitch flags get <flag-id-or-key> [flags]");
    expect(verify).toContain("Client Key is public");
    expect(clientKey).toContain("Client Key is public");
    expect(apiKey).toContain("API Key is secret and server-side only");
    expect(apiKey).toContain("shown once and cannot be read back");
  });

  it("surfaces the kill-switch-off exemption on flag-config update and env-policy help (SPL-312)", () => {
    const flagConfigUpdate = renderHelp(["flag-config", "update", "--help"]);
    const envPolicyGet = renderHelp(["env-policy", "get", "--help"]);
    const envPolicySet = renderHelp(["env-policy", "set", "--help"]);

    expect(flagConfigUpdate).toContain(KILL_SWITCH_OFF_EXEMPTION);
    expect(envPolicyGet).toContain(KILL_SWITCH_OFF_EXEMPTION);
    expect(envPolicySet).toContain(KILL_SWITCH_OFF_EXEMPTION);
  });

  it.each([
    ["--help"],
    ["-h"],
    ["flags", "verify", "--help"],
  ])("prints help to stdout and exits successfully for %j", async (...args: string[]) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(args)).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns identical stderr for unmatched --help and -h command paths", async () => {
    const longHelpStderr = await unmatchedHelpStderr("--help");
    const shortHelpStderr = await unmatchedHelpStderr("-h");

    expect(longHelpStderr).toBe(shortHelpStderr);
    expect(longHelpStderr).toContain("CLI_USAGE_INVALID: Cause: Unknown command");
    expect(longHelpStderr).not.toContain("requires a value");
  });
});

async function unmatchedHelpStderr(helpFlag: "--help" | "-h"): Promise<string> {
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});

  await expect(runCli(["flags", "bogus", helpFlag])).resolves.toBe(EXIT_USAGE);
  vi.restoreAllMocks();
  return stderr.join("\n");
}
