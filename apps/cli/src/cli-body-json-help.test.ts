import {
  describeRequestBody,
  EnvironmentPolicySchema,
  requestBodySchemaForOperation,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLI_COMMANDS, type CliCommandDefinition } from "./command-registry.js";
import { renderCommandHelp } from "./help.js";
import { commandBodySchemaHelp, commandHasBodyJson, formatBodyJsonHelp } from "./help-body-json.js";

const BODY_JSON_COMMANDS = CLI_COMMANDS.filter(commandHasBodyJson);

function requireCommand(
  predicate: (command: CliCommandDefinition) => boolean,
  label: string,
): CliCommandDefinition {
  const command = BODY_JSON_COMMANDS.find(predicate);
  expect(command, label).toBeDefined();
  if (!command) throw new Error(label);
  return command;
}

describe("CLI --body-json schema help (SPL-309)", () => {
  it("covers every --body-json command, not a sampled subset", () => {
    expect(BODY_JSON_COMMANDS.length).toBeGreaterThan(20);
    const paths = BODY_JSON_COMMANDS.map((command) => command.path.join(" "));
    expect(paths).toEqual(
      expect.arrayContaining([
        "flag-config update",
        "flag-targeting-rules replace",
        "experiments create",
        "experiments update",
        "env-policy set",
        "approval-request-reviews create",
      ]),
    );
  });

  it("prints contract-required field names in --help for every --body-json command", () => {
    for (const command of BODY_JSON_COMMANDS) {
      const helpText = renderCommandHelp(command);
      expect(helpText).toContain("--body-json <json>");
      expect(helpText).toContain("Request body (--body-json):");

      const schemaHelp = commandBodySchemaHelp(command);
      for (const field of schemaHelp.fields.filter((item) => item.required)) {
        expect(
          helpText,
          `${command.path.join(" ")} missing required field ${field.name}`,
        ).toContain(field.name);
      }
      expect(helpText).toContain("Example:");
      expect(helpText).toContain(JSON.stringify(schemaHelp.example));
    }
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
    const fromHelp = renderCommandHelp(
      requireCommand(
        (command) => command.operationId === "flag_config_update",
        "flag-config update",
      ),
    );
    for (const field of fromSchema.fields) {
      expect(fromHelp).toContain(field.name);
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
});
