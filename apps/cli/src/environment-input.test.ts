import { afterEach, describe, expect, it, vi } from "vitest";
import { type CliCommandDefinition, findCommand } from "./command-registry.js";
import { applyEnvironmentFields } from "./environment-input.js";
import { renderCommandHelp } from "./help.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

const now = Date.parse("2026-10-17T12:00:00.000Z");

function command(path: string[]): CliCommandDefinition {
  const result = findCommand(path);
  if (!result) throw new Error(`Missing command ${path.join(" ")}`);
  return result;
}

function inputFor(path: string[], flags: string[]) {
  return buildOperationInput(command(path), parseInvocation([...path, ...flags]), {
    appId: "app_1",
    environmentId: "env_temporary",
  });
}

afterEach(() => vi.useRealTimers());

describe("Temporary Environment CLI inputs", () => {
  it("creates a Temporary Environment with a relative expiry independently of Flag lifecycle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(
      inputFor(
        ["envs", "create"],
        ["--key", "pr-123", "--temporary", "--from", "prod", "--expires-at", "3d"],
      ),
    ).toEqual({
      appId: "app_1",
      key: "pr-123",
      temporary: { fromEnvironmentId: "prod", expiresAt: "2026-10-20T12:00:00.000Z" },
    });
  });

  it("omits expiry for the server default and leaves permanent create unchanged", () => {
    expect(
      inputFor(["envs", "create"], ["--key", "pr-123", "--temporary", "--from", "prod"]),
    ).toEqual({
      appId: "app_1",
      key: "pr-123",
      temporary: { fromEnvironmentId: "prod" },
    });
    expect(inputFor(["envs", "create"], ["--key", "staging"])).toEqual({
      appId: "app_1",
      key: "staging",
    });
  });

  it("normalizes an ISO expiry with an offset", () => {
    const input = {};
    applyEnvironmentFields(
      "environments_create",
      parseInvocation([
        "--temporary",
        "--from",
        "prod",
        "--expires-at",
        "2026-10-20T14:00:00+02:00",
      ]).flags,
      input,
      now,
    );
    expect(input).toEqual({
      temporary: {
        fromEnvironmentId: "prod",
        expiresAt: "2026-10-20T12:00:00.000Z",
      },
    });
  });

  it("merges source flags into a nested body and uses body sources for create and Sync", () => {
    expect(
      inputFor(
        ["envs", "create"],
        [
          "--key",
          "pr-123",
          "--temporary",
          "--body-json",
          JSON.stringify({ temporary: { fromEnvironmentId: "prod" } }),
        ],
      ),
    ).toMatchObject({ temporary: { fromEnvironmentId: "prod" } });
    expect(
      inputFor(
        ["envs", "sync"],
        ["--body-json", JSON.stringify({ fromEnvironmentId: "prod" }), "--from", "dev"],
      ),
    ).toEqual({ appId: "app_1", environmentId: "env_temporary", fromEnvironmentId: "dev" });
    expect(
      inputFor(["envs", "sync"], ["--body-json", JSON.stringify({ fromEnvironmentId: "prod" })]),
    ).toEqual({ appId: "app_1", environmentId: "env_temporary", fromEnvironmentId: "prod" });
  });

  it("uses the selected Environment as Sync target and keeps its canonical selector", () => {
    expect(inputFor(["envs", "sync"], ["--from", "dev", "--by", "id"])).toEqual({
      appId: "app_1",
      environmentId: "env_temporary",
      fromEnvironmentId: "dev",
      by: "id",
    });
  });
});

describe("Temporary Environment CLI invalid inputs", () => {
  it.each([
    [["envs", "create"], ["--temporary"]],
    [
      ["envs", "create"],
      ["--from", "prod"],
    ],
    [
      ["envs", "create"],
      ["--expires-at", "3d"],
    ],
    [
      ["envs", "create"],
      ["--temporary", "--from", "prod", "--owner", "team"],
    ],
    [
      ["envs", "create"],
      ["--temporary", "--from", "prod", "--lifecycle-class", "ops"],
    ],
    [["envs", "sync"], []],
    [
      ["envs", "sync"],
      ["--from", "prod", "--temporary"],
    ],
    [
      ["envs", "sync"],
      ["--from", "prod", "--expires-at", "3d"],
    ],
    [["envs", "update"], ["--temporary"]],
    [
      ["envs", "delete"],
      ["--from", "prod"],
    ],
    [["flags", "create"], ["--temporary"]],
    [
      ["flags", "list"],
      ["--from", "prod"],
    ],
    [
      ["envs", "create"],
      ["--temporary", "--body-json", '{"temporary":null}'],
    ],
    [
      ["envs", "create"],
      ["--temporary", "--body-json", '{"temporary":[]}'],
    ],
  ])("rejects invalid command and flag combinations %j %j", (path, flags) => {
    expect(() => inputFor(path, flags)).toThrow(
      expect.objectContaining({ code: "CLI_USAGE_INVALID" }),
    );
  });

  it.each([
    "never",
    "none",
    "invalid",
    "2026-10-20",
    "2026-10-20T12:00:00",
    "0d",
    "8d",
    "2026-10-17T12:01:00Z",
  ])("rejects invalid or out-of-bounds temporary expiry %s", (expiresAt) => {
    expect(() =>
      applyEnvironmentFields(
        "environments_create",
        parseInvocation(["--temporary", "--from", "prod", "--expires-at", expiresAt]).flags,
        {},
        now,
      ),
    ).toThrow(expect.objectContaining({ code: "CLI_USAGE_INVALID" }));
  });

  it("documents creation, Sync, expiry bounds and the source selector", () => {
    const create = renderCommandHelp(command(["envs", "create"]));
    expect(create).toContain("--temporary");
    expect(create).toContain("--from <environment>");
    expect(create).toContain("--expires-at <instant|days>");
    expect(create).toContain("at most seven days");
    expect(renderCommandHelp(command(["envs", "sync"]))).toContain("--from <environment>");
  });
});
