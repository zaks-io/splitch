import { describe, expect, it } from "vitest";
import { findCommand } from "./command-registry.js";
import { executeInvocation } from "./execute.js";
import type { CliIo } from "./execute-types.js";
import { EXIT_OK } from "./exit-codes.js";
import { renderCommandHelp } from "./help.js";
import { emitOperationNotices, formatFrozenTargetingNotice } from "./operation-notices.js";
import { parseInvocation } from "./parse-args.js";
import { FakeCliTransport, startRunResponse, storedCredential } from "./test-fixtures.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";

describe("SPL-307 CLI frozen targeting notices", () => {
  it("formats an empty frozen set without requiring --json parsing", () => {
    expect(formatFrozenTargetingNotice("run_1", [])).toContain(
      "Flag Configuration targeting rules do not apply while this Run is live",
    );
    expect(formatFrozenTargetingNotice("run_1", [])).toContain("all Entities eligible");
  });

  it("prints Start frozen-targeting notice to stderr when not --json", () => {
    const errors: string[] = [];
    const io: CliIo = {
      log: () => {},
      error: (line) => {
        errors.push(line);
      },
    };
    emitOperationNotices(
      "experiments_start",
      { ...startRunResponse, frozenTargetingRules: [] },
      false,
      io,
    );
    expect(errors.some((line) => line.includes("Frozen targeting rules for run_1"))).toBe(true);
  });

  it("prints live-Run-unaffected notice for a staged Targeting Rule edit", () => {
    const errors: string[] = [];
    const io: CliIo = {
      log: () => {},
      error: (line) => {
        errors.push(line);
      },
    };
    emitOperationNotices(
      "experiments_update",
      {
        id: "exp_1",
        liveRunUnaffected: {
          runId: "run_live",
          frozenTargetingRules: [
            {
              id: "rule_frozen",
              priority: 0,
              conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
            },
          ],
        },
      },
      false,
      io,
    );
    expect(errors.some((line) => line.includes("Live Run run_live is unaffected"))).toBe(true);
    expect(errors.some((line) => line.includes("rule_frozen@0"))).toBe(true);
  });

  it("stays quiet under --json", () => {
    const errors: string[] = [];
    const io: CliIo = {
      log: () => {},
      error: (line) => {
        errors.push(line);
      },
    };
    emitOperationNotices("experiments_start", startRunResponse, true, io);
    emitOperationNotices(
      "experiments_update",
      { liveRunUnaffected: { runId: "run_1", frozenTargetingRules: [] } },
      true,
      io,
    );
    expect(errors).toEqual([]);
  });

  it("documents Start and targeting-rule freeze behavior in --help", () => {
    const start = findCommand(["experiments", "start"]);
    const update = findCommand(["experiments", "update"]);
    const targeting = findCommand(["flag-targeting-rules", "replace"]);
    expect(start).toBeDefined();
    expect(update).toBeDefined();
    expect(targeting).toBeDefined();
    if (!start || !update || !targeting) return;

    const startHelp = renderCommandHelp(start);
    expect(startHelp).toContain("frozenTargetingRules");
    expect(startHelp).toContain("Flag Configuration targeting rules do not apply");

    const updateHelp = renderCommandHelp(update);
    expect(updateHelp).toContain("liveRunUnaffected");
    expect(updateHelp).toContain("stageForNextRun");

    const targetingHelp = renderCommandHelp(targeting);
    expect(targetingHelp).toContain("RUN_FROZEN");
    expect(targetingHelp).toContain("frozen targetingRules snapshot");
  });

  it("surfaces the frozen-targeting line on a successful experiments start", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/start") && request.method === "POST",
        status: 200,
        body: startRunResponse,
      },
    ]);

    const invocation = parseInvocation([
      "experiments",
      "start",
      "exp_1",
      "--app",
      "app_1",
      "--env",
      "env_1",
      "--idempotency-key",
      "idem-start",
    ]);
    const result = await executeInvocation(invocation, {
      fetch: transport.fetch,
      credentialStore: {
        load: async () => storedCredential(),
        save: async () => {},
        clear: async () => {},
      },
      io: {
        log: (line) => {
          logs.push(line);
        },
        error: (line) => {
          errors.push(line);
        },
      },
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(errors.some((line) => line.includes("Frozen targeting rules for run_1"))).toBe(true);
    expect(logs.some((line) => line.includes("frozenTargetingRules"))).toBe(true);
  });
});
