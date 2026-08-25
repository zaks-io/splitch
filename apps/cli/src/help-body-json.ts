import {
  describeRequestBody,
  EnvironmentPolicySchema,
  type RequestBodyHelp,
  requestBodySchemaForOperation,
} from "@splitch/contracts";
import type { CliCommandDefinition } from "./command-registry.js";

/**
 * Schema-derived `--body-json` help. Bound to the route body (or the bare
 * Environment Policy for `env-policy set`). A command that advertises
 * `--body-json` without a bindable schema fails closed in tests.
 */

export function commandHasBodyJson(command: CliCommandDefinition): boolean {
  if (command.kind === "flags_verify" || command.kind.startsWith("cloudflare_")) return false;
  if (command.kind === "env_policy_set") return true;
  return requestBodySchemaForOperation(command.operationId) !== undefined;
}

/** Resolve the Zod body this CLI command accepts via `--body-json`. */
export function commandBodySchemaHelp(command: CliCommandDefinition): RequestBodyHelp {
  const schema =
    command.kind === "env_policy_set"
      ? EnvironmentPolicySchema
      : requestBodySchemaForOperation(command.operationId);
  if (!schema) {
    throw new Error(
      `CLI command ${command.path.join(" ")} advertises --body-json without a request body schema`,
    );
  }
  return describeRequestBody(schema);
}

/** Help lines for the Request body section (excluding the section header). */
export function formatBodyJsonHelp(help: RequestBodyHelp): string[] {
  if (help.fields.length === 0) {
    return ["  (empty object)", "  Example:", `    ${JSON.stringify(help.example)}`];
  }
  const nameWidth = Math.max(...help.fields.map((field) => field.name.length));
  const lines = help.fields.map((field) => {
    const presence = field.required ? "required" : "optional";
    const defaultSuffix =
      field.defaultValue !== undefined ? `; default ${JSON.stringify(field.defaultValue)}` : "";
    return `  ${field.name.padEnd(nameWidth)}  ${presence}${defaultSuffix}  ${field.typeLabel}`;
  });
  lines.push("  Example:");
  lines.push(`    ${JSON.stringify(help.example)}`);
  return lines;
}

export function renderBodyJsonSection(command: CliCommandDefinition): string[] {
  if (!commandHasBodyJson(command)) return [];
  const help = commandBodySchemaHelp(command);
  return ["", "Request body (--body-json):", ...formatBodyJsonHelp(help)];
}

export function bodyJsonExampleFlag(command: CliCommandDefinition): string | undefined {
  if (!commandHasBodyJson(command)) return undefined;
  return JSON.stringify(commandBodySchemaHelp(command).example);
}
