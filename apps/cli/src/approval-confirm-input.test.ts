import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { type CliCommandDefinition, findCommand } from "./command-registry.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

function requireCommand(path: string[]): CliCommandDefinition {
  const command = findCommand(path);
  if (!command) throw new Error(`no CLI command registered for "${path.join(" ")}"`);
  return command;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SPL-455 --confirm on body approval operations", () => {
  it("maps --confirm on flag-variants create", () => {
    const command = requireCommand(["flag-variants", "create"]);
    expect(command.supportsConfirm).toBe(true);
    const invocation = parseInvocation([
      "flag-variants",
      "create",
      "--confirm",
      "--app",
      "app_cli",
      "flag_cli",
      "--name",
      "treatment-b",
      "--body-json",
      '{"value":true}',
    ]);

    const input = buildOperationInput(command, invocation, { appId: "app_cli" });

    expect(input.review).toEqual({ action: "approve_and_apply" });
    expect(input.flagId).toBe("flag_cli");
    expect(input.name).toBe("treatment-b");
    expect(input.value).toBe(true);
  });

  it("maps --confirm on segments update", () => {
    const command = requireCommand(["segments", "update"]);
    expect(command.supportsConfirm).toBe(true);
    const invocation = parseInvocation([
      "segments",
      "update",
      "--confirm",
      "--app",
      "app_cli",
      "seg_cli",
      "--name",
      "enterprise",
    ]);

    const input = buildOperationInput(command, invocation, { appId: "app_cli" });

    expect(input.review).toEqual({ action: "approve_and_apply" });
    expect(input.segmentId).toBe("seg_cli");
    expect(input.name).toBe("enterprise");
  });

  it("rejects --confirm on unsupported commands before any request", async () => {
    const stderr: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runCli(["flags", "delete", "flag_1", "--confirm"], { fetch });

    expect(exitCode).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("--confirm is not accepted by splitch flags delete");
  });
});
