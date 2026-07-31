import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, META_COMMANDS } from "./command-registry.js";
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
    const clientKey = renderHelp(["client-key", "get", "--help"]);
    const apiKey = renderHelp(["api-keys", "create", "--help"]);

    expect(verify).toContain("Usage:\n  splitch flags verify <flag-key> [flags]");
    expect(verify).toContain("Verify a Flag KEY");
    expect(verify).toContain("Client Key is public");
    expect(clientKey).toContain("Client Key is public");
    expect(apiKey).toContain("API Key is secret and server-side only");
    expect(apiKey).toContain("shown once and cannot be read back");
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
});
