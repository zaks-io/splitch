import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findCommand } from "./command-registry.js";
import { SplitchCliError } from "./errors.js";
import { commandFlags } from "./help-flags.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";
import { applyQueryFlagsForSchema, fieldNameToKebab, queryFlagSpecs } from "./query-flags.js";

describe("derived query flags", () => {
  it("maps schema field names to kebab-case flags", () => {
    expect(fieldNameToKebab("cursor")).toBe("cursor");
    expect(fieldNameToKebab("target_kind")).toBe("target-kind");
    expect(fieldNameToKebab("fromEnvironmentId")).toBe("from-environment-id");
    expect(fieldNameToKebab("runId")).toBe("run-id");
  });

  it("derives pagination and filter flags for approval-requests list", () => {
    const specs = queryFlagSpecs("approval_requests_list");
    expect(specs.map((spec) => spec.kebab).sort()).toEqual([
      "cursor",
      "limit",
      "status",
      "target-kind",
    ]);
    const help = commandFlags(requireCommand(["approval-requests", "list"]));
    expect(help.map((flag) => flag.syntax)).toEqual(
      expect.arrayContaining([
        "--cursor <cursor>",
        "--limit <limit>",
        "--status <status>",
        "--target-kind <target-kind>",
      ]),
    );
  });

  it("forwards --cursor and --limit on approval-requests list", () => {
    const command = requireCommand(["approval-requests", "list"]);
    const input = buildOperationInput(
      command,
      parseInvocation([
        "approval-requests",
        "list",
        "--json",
        "--app",
        "app_cli",
        "--cursor",
        "page_2",
        "--limit",
        "25",
      ]),
      { appId: "app_cli" },
    );
    expect(input).toMatchObject({
      appId: "app_cli",
      cursor: "page_2",
      limit: 25,
    });
  });

  it("rejects an invalid typed query value with CLI_USAGE_INVALID", () => {
    const command = requireCommand(["approval-requests", "list"]);
    expect(() =>
      buildOperationInput(
        command,
        parseInvocation([
          "approval-requests",
          "list",
          "--json",
          "--app",
          "app_cli",
          "--limit",
          "not-a-number",
        ]),
        { appId: "app_cli" },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CLI_USAGE_INVALID",
        message: expect.stringContaining("--limit"),
      }),
    );
  });

  it("rejects a missing required query flag with a stable error", () => {
    const schema = z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
      })
      .strict();
    try {
      applyQueryFlagsForSchema(schema, { to: "2026-01-02" }, {}, ["flag-changes", "export"]);
      throw new Error("expected a missing required query flag to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitchCliError);
      expect(error).toMatchObject({
        code: "CLI_USAGE_INVALID",
        message: expect.stringContaining("--from is required"),
      });
    }
  });

  it("keeps hand-mapped --from-environment-id working alongside query flags", () => {
    const command = requireCommand(["flags", "promote"]);
    const input = buildOperationInput(
      command,
      parseInvocation(["flags", "promote", "flag_1", "--from-environment-id", "env_dev", "--json"]),
      { appId: "app_cli", environmentId: "env_prod", environmentSource: "flag" },
    );
    expect(input.fromEnvironmentId).toBe("env_dev");
  });
});

function requireCommand(path: readonly string[]) {
  const command = findCommand(path);
  if (!command) throw new Error(`missing command ${path.join(" ")}`);
  return command;
}
