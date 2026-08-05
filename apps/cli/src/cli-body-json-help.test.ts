import {
  describeRequestBody,
  EnvironmentPolicySchema,
  isMcpToolRoute,
  requestBodySchemaForOperation,
  routeRegistry,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLI_COMMANDS, type CliCommandDefinition } from "./command-registry.js";
import { renderCommandHelp } from "./help.js";
import { commandBodySchemaHelp, commandHasBodyJson, formatBodyJsonHelp } from "./help-body-json.js";

function requireCommand(
  predicate: (command: CliCommandDefinition) => boolean,
  label: string,
): CliCommandDefinition {
  const command = CLI_COMMANDS.find(predicate);
  expect(command, label).toBeDefined();
  if (!command) throw new Error(label);
  return command;
}

function fieldRows(bodySection: string): string[] {
  return bodySection.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    return (
      trimmed.length > 0 &&
      !trimmed.startsWith("Example:") &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("(empty")
    );
  });
}

function assertBodyJsonExampleValid(command: CliCommandDefinition): void {
  const help = commandBodySchemaHelp(command);
  const schema =
    command.kind === "env_policy_set"
      ? EnvironmentPolicySchema
      : requestBodySchemaForOperation(command.operationId);
  expect(schema, `${command.path.join(" ")} missing schema`).toBeDefined();
  if (!schema) return;
  const parsed = schema.safeParse(help.example);
  expect(
    parsed.success,
    `${command.path.join(" ")} example invalid: ${parsed.success ? "" : parsed.error.message}`,
  ).toBe(true);
  expect(JSON.stringify(help.example)).not.toMatch(/secret|token|password|api[_-]?key/i);
}

function assertHandWrittenKindPolicy(kind: CliCommandDefinition["kind"]): void {
  const commands = CLI_COMMANDS.filter((command) => command.kind === kind);
  for (const command of commands) {
    assertOneHandWrittenCommand(kind, command);
  }
}

function assertOneHandWrittenCommand(
  kind: CliCommandDefinition["kind"],
  command: CliCommandDefinition,
): void {
  if (kind === "flags_verify" || kind === "env_policy_get") {
    expect(commandHasBodyJson(command)).toBe(false);
    expect(renderCommandHelp(command)).not.toContain("Request body (--body-json):");
    return;
  }
  if (kind === "env_policy_set") {
    expect(commandHasBodyJson(command)).toBe(true);
    expect(renderCommandHelp(command)).toContain("Request body (--body-json):");
    expect(
      commandBodySchemaHelp(command)
        .fields.map((field) => field.name)
        .sort(),
    ).toEqual(Object.keys(EnvironmentPolicySchema.shape).sort());
    return;
  }
  expect.fail(`hand-written kind "${kind}" on ${command.path.join(" ")} has no body-schema policy`);
}

/** Control-plane routes that declare a JSON request body (the enforceable criterion-3 set). */
function mcpRoutesWithJsonBody() {
  return routeRegistry.filter(
    (route) =>
      isMcpToolRoute(route) && requestBodySchemaForOperation(route.operationId) !== undefined,
  );
}

describe("CLI --body-json schema help coverage (SPL-309)", () => {
  it("renders a Request body section for every MCP route with a JSON body", () => {
    const bodyRoutes = mcpRoutesWithJsonBody();
    expect(bodyRoutes.length).toBeGreaterThan(20);
    expect(bodyRoutes.map((route) => route.operationId)).toEqual(
      expect.arrayContaining([
        "flag_config_update",
        "flag_targeting_rules_replace",
        "experiments_create",
        "experiments_update",
        "environments_update",
        "approval_request_reviews_create",
        "flags_promote",
      ]),
    );

    for (const route of bodyRoutes) {
      const command = requireCommand(
        (candidate) => candidate.kind === "api" && candidate.operationId === route.operationId,
        `api command for body route ${route.operationId}`,
      );
      const helpText = renderCommandHelp(command);
      expect(
        helpText,
        `${command.path.join(" ")} missing --body-json for route ${route.operationId}`,
      ).toContain("--body-json <json>");
      expect(
        helpText,
        `${command.path.join(" ")} missing Request body section for route ${route.operationId}`,
      ).toContain("Request body (--body-json):");
    }
  });

  it("prints contract-required field names in the Request body section", () => {
    for (const route of mcpRoutesWithJsonBody()) {
      const command = requireCommand(
        (candidate) => candidate.kind === "api" && candidate.operationId === route.operationId,
        `api command for ${route.operationId}`,
      );
      const schemaHelp = commandBodySchemaHelp(command);
      const bodySection = formatBodyJsonHelp(schemaHelp).join("\n");
      const rows = fieldRows(bodySection);
      for (const field of schemaHelp.fields.filter((item) => item.required)) {
        expect(
          rows.some((row) => row.trimStart().startsWith(field.name) && row.includes("required")),
          `${command.path.join(" ")} missing required field row for ${field.name}`,
        ).toBe(true);
      }
      expect(bodySection).toContain("Example:");
      expect(bodySection).toContain(JSON.stringify(schemaHelp.example));
    }
  });

  it("derives a schema-valid example for every MCP body route and env-policy set", () => {
    for (const route of mcpRoutesWithJsonBody()) {
      assertBodyJsonExampleValid(
        requireCommand(
          (candidate) => candidate.kind === "api" && candidate.operationId === route.operationId,
          `api command for ${route.operationId}`,
        ),
      );
    }
    assertBodyJsonExampleValid(
      requireCommand((command) => command.kind === "env_policy_set", "env-policy set"),
    );
  });
});

describe("CLI --body-json schema help details (SPL-309)", () => {
  it("lists nested enums for targeting-rules replace (not bare object[])", () => {
    const command = requireCommand(
      (candidate) => candidate.operationId === "flag_targeting_rules_replace",
      "flag-targeting-rules replace",
    );
    const bodySection = formatBodyJsonHelp(commandBodySchemaHelp(command)).join("\n");
    expect(bodySection).toContain("targetingRules");
    expect(bodySection).toContain('"eq"');
    expect(bodySection).toContain('"not_matches"');
    expect(bodySection).toContain("percentage");
    expect(bodySection).not.toMatch(/conditions:\s*object\[\]/);
    expect(bodySection).not.toMatch(/percentageRollout\?:?\s*object/);
  });

  it("lists enum-constrained values in help for Environment Policy and review action", () => {
    const policyHelp = renderCommandHelp(
      requireCommand((command) => command.kind === "env_policy_set", "env-policy set"),
    );
    expect(policyHelp).toContain('"allow"');
    expect(policyHelp).toContain('"confirm"');

    const reviewHelp = renderCommandHelp(
      requireCommand(
        (command) => command.operationId === "approval_request_reviews_create",
        "approval-request-reviews create",
      ),
    );
    expect(reviewHelp).toContain("approve_and_apply");
    expect(reviewHelp).toContain("decline");
  });

  it("derives help from the contract schema at runtime (no hand-written field tables)", () => {
    const unique = `derived_field_${Date.now()}`;
    const schema = z.object({ [unique]: z.enum(["alpha", "beta"]) });
    const derived = describeRequestBody(schema);
    const rendered = formatBodyJsonHelp(derived).join("\n");
    expect(rendered).toContain(unique);
    expect(rendered).toContain('"alpha"');
    expect(rendered).toContain('"beta"');

    const routeSchema = requestBodySchemaForOperation("flag_config_update");
    expect(routeSchema).toBeDefined();
    if (!routeSchema) throw new Error("flag_config_update body schema missing");
    const fromSchema = describeRequestBody(routeSchema);
    const bodySection = formatBodyJsonHelp(
      commandBodySchemaHelp(
        requireCommand(
          (command) => command.operationId === "flag_config_update",
          "flag-config update",
        ),
      ),
    ).join("\n");
    for (const field of fromSchema.fields) {
      expect(fieldRows(bodySection).some((row) => row.trimStart().startsWith(field.name))).toBe(
        true,
      );
    }
  });

  it("requires an explicit body-schema policy for every non-api command kind", () => {
    const kinds = new Set(CLI_COMMANDS.map((command) => command.kind));
    for (const kind of kinds) {
      if (kind === "api") continue;
      assertHandWrittenKindPolicy(kind);
    }
  });

  it("fails closed when a --body-json command has no schema binding", () => {
    expect(() =>
      commandBodySchemaHelp({
        operationId: "not_a_bound_operation",
        path: ["ghost", "mutate"],
        needsApp: false,
        needsEnvironment: false,
        supportsConfirm: false,
        kind: "api",
      }),
    ).toThrow(/without a request body schema/);
  });

  it("binds env-policy set to the bare Environment Policy schema", () => {
    const command = requireCommand((item) => item.kind === "env_policy_set", "env-policy set");
    const help = commandBodySchemaHelp(command);
    expect(help.fields.map((field) => field.name).sort()).toEqual(
      Object.keys(EnvironmentPolicySchema.shape).sort(),
    );
    expect(EnvironmentPolicySchema.safeParse(help.example).success).toBe(true);
  });

  it("includes a non-idempotency mutation field in flag-config update example", () => {
    const help = commandBodySchemaHelp(
      requireCommand(
        (command) => command.operationId === "flag_config_update",
        "flag-config update",
      ),
    );
    expect(help.example).toEqual(
      expect.objectContaining({
        idempotency_key: expect.any(String),
      }),
    );
    expect(Object.keys(help.example as Record<string, unknown>).length).toBeGreaterThan(1);
  });

  it("avoids domain-confused placeholders on flag-variants update and experiments start", () => {
    const variants = commandBodySchemaHelp(
      requireCommand(
        (command) => command.operationId === "flag_variants_update",
        "flag-variants update",
      ),
    );
    expect(JSON.stringify(variants.example)).not.toContain("Checkout");
    expect(JSON.stringify(variants.example)).not.toContain('"US"');

    const start = commandBodySchemaHelp(
      requireCommand((command) => command.operationId === "experiments_start", "experiments start"),
    );
    expect(start.example).not.toHaveProperty("sampleSizeLocked");
    expect(start.example).toEqual(
      expect.objectContaining({
        horizon: "sequential",
        idempotency_key: expect.any(String),
      }),
    );
  });
});
