import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/sdk/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { CLI_COMMANDS, META_COMMANDS } from "./command-registry.js";
import { requiredPositionalSpecs } from "./command-positionals.js";
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

  it("pins Flag Key wording and the Client Key versus API Key boundary", () => {
    const verify = renderHelp(["flags", "verify", "--help"]);
    const flagsGet = renderHelp(["flags", "get", "--help"]);
    const clientKey = renderHelp(["client-key", "get", "--help"]);
    const apiKey = renderHelp(["api-keys", "create", "--help"]);

    expect(verify).toContain("Usage:\n  splitch flags verify <flag-key> [flags]");
    expect(verify).toContain("Verify a Flag Key");
    expect(flagsGet).toContain("Usage:\n  splitch flags get <flag-id-or-key> [flags]");
    expect(verify).toContain("Client Key is public");
    expect(clientKey).toContain("Client Key is public");
    expect(apiKey).toContain("API Key is secret and server-side only");
    expect(apiKey).toContain("shown once and cannot be read back");
  });

  it("leads a first-time user through the simple flag surface before body JSON", () => {
    const root = renderRootHelp();
    const orgCreate = renderHelp(["orgs", "create", "--help"]);
    const appCreate = renderHelp(["apps", "create", "--help"]);
    const flagConfig = renderHelp(["flag-config", "update", "--help"]);
    const health = renderMetaHelp("health");

    expect(root).toContain("feature flags and A/B experimentation from your terminal");
    expect(root).toContain("-v, --version");
    expect(root).toContain("Start here:\n  splitch login");
    expect(orgCreate).toContain('splitch orgs create --name "My Org" --json');
    expect(appCreate).toContain("Usage:\n  splitch apps create --org <organization> [flags]");
    expect(appCreate).toContain('splitch apps create --org <organization> --name "My App" --json');
    expect(flagConfig).toContain(
      "splitch flag-config update <flag-id-or-key> --enabled true --rollout 100 --json",
    );
    expect(flagConfig).toContain(
      "Send 0-100% of fall-through traffic to the one non-Default available Variant; the rest serves the Default Variant. Use none to clear the rollout.",
    );
    expect(health).toContain("splitch health --json");
  });

  it("documents Organization selectors consistently as --org", () => {
    const organizationCommands = CLI_COMMANDS.filter((command) =>
      requiredPositionalSpecs(command).some((spec) => spec.param === "orgId"),
    );

    expect(organizationCommands.some((command) => command.path[0] !== "apps")).toBe(true);
    for (const command of organizationCommands) {
      const help = renderCommandHelp(command);
      expect(help).toMatch(
        /^ {2}--org <organization>\s+\[type: string; default: none\] Organization ID\.$/m,
      );
      const usageAndExample = help.split("\n").filter((line) => line.startsWith("  splitch "));
      expect(usageAndExample).toHaveLength(2);
      expect(usageAndExample.every((line) => line.includes("--org <organization>"))).toBe(true);
      expect(usageAndExample.every((line) => !line.includes("<org-id>"))).toBe(true);
    }
  });

  it("documents the project config format and nearest-parent behavior", () => {
    const use = renderMetaHelp("use");

    expect(use).toContain('{"version":1,"app":"app_...","environment":"env_..."}');
    expect(use).toContain("current directory and each parent for splitch.json");
    expect(use).toContain("the nearest file wins");
    expect(use).toContain("creates splitch.json in the current directory when none exists");
  });

  it("documents hydrated Flag reads and the compact human summary", () => {
    const help = renderHelp(["flags", "list", "--help"]);
    const getHelp = renderHelp(["flags", "get", "--help"]);

    expect(help).toContain("complete per-Environment Flag Configurations");
    expect(help).toContain("--summary");
    expect(help).not.toContain("--with-config");
    expect(help).toContain("splitch flags list --json");
    expect(getHelp).toContain("cannot be combined with --summary");
    expect(getHelp).not.toContain("flags list --summary");
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
