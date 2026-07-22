import type { RecommendedAction } from "@splitch/contracts";

export const MCP_PROMPT_NAMES = [
  "onboard_new_app",
  "ship_a_flag",
  "run_an_experiment",
  "end_a_run",
  "recover_from_error",
  "diagnose_setup",
] as const;

export type McpPromptName = (typeof MCP_PROMPT_NAMES)[number];

interface McpPromptArgumentDefinition {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface McpPromptDefinition {
  readonly name: McpPromptName;
  readonly description: string;
  readonly arguments: readonly McpPromptArgumentDefinition[];
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: {
    readonly type: "text";
    readonly text: string;
  };
}

export interface McpPromptResult {
  readonly description: string;
  readonly messages: readonly McpPromptMessage[];
}

/** Internal plan shape used by drift-guard and tests. */
export interface McpPromptPlan extends McpPromptResult {
  readonly operationIds: readonly string[];
}

export const PROMPT_DEFINITIONS: readonly McpPromptDefinition[] = [
  {
    name: "onboard_new_app",
    description:
      "Plan: create an App, select dev, fetch a Client Key, create a Flag, and confirm with flags_test_eval.",
    arguments: [
      { name: "orgId", description: "Organization id that will own the App.", required: true },
      { name: "appName", description: "Display name for the new App.", required: true },
    ],
  },
  {
    name: "ship_a_flag",
    description:
      "Plan: create a Flag, promote Variants into the active Environment, and confirm with flags_test_eval.",
    arguments: [
      { name: "flagKey", description: "Flag key to create.", required: true },
      {
        name: "variants",
        description: "Variant names for the Flag (comma-separated or JSON array).",
        required: true,
      },
    ],
  },
  {
    name: "run_an_experiment",
    description:
      "Plan: create an Experiment, Start a Run, confirm resolution with flags_test_eval, then poll experiment_results_get.",
    arguments: [
      { name: "flagId", description: "Flag id the Experiment targets.", required: true },
      {
        name: "variants",
        description: "Variant set for the Experiment allocation.",
        required: true,
      },
      { name: "allocation", description: "Allocation map for the Experiment Run.", required: true },
    ],
  },
  {
    name: "end_a_run",
    description:
      "Plan: capture current resolution with flags_test_eval, End the Run, and confirm RUN_NOT_RUNNING.",
    arguments: [{ name: "runId", description: "Run id to End.", required: true }],
  },
  {
    name: "recover_from_error",
    description:
      "Plan: map details.recommendedAction to the remediation tool sequence for an operational 409.",
    arguments: [
      {
        name: "errorCode",
        description: "ErrorResponse.code from the failed tool call.",
        required: true,
      },
      {
        name: "details",
        description: "ErrorResponse.details object or JSON string; must include recommendedAction.",
        required: true,
      },
    ],
  },
  {
    name: "diagnose_setup",
    description:
      "Plan: resolve active context, fetch the Client Key, and confirm wiring with flags_test_eval.",
    arguments: [],
  },
];

/** Remediation sequences keyed by recommendedAction (mcp-discovery.md Recovery). */
export const RECOVERY_OPERATION_IDS: Readonly<Record<RecommendedAction, readonly string[]>> = {
  CREATE_NEW_RUN: ["experiments_create", "experiments_start", "flags_test_eval"],
  END_RUNNING_RUN_FIRST: ["runs_end"],
  START_A_RUN: ["experiments_start"],
  EDIT_DRAFT_THEN_START: ["experiments_start"],
  ADD_VARIANT_TO_ENV: ["flags_promote"],
  RETRY_AFTER: [],
  RETRY_WITH_CONFIRMATION: [],
};

const PROMPT_DESCRIPTION_BY_NAME = new Map(
  PROMPT_DEFINITIONS.map((prompt) => [prompt.name, prompt.description] as const),
);

export function promptDescription(name: McpPromptName): string {
  const description = PROMPT_DESCRIPTION_BY_NAME.get(name);
  if (!description) {
    throw new Error(`mcp-prompts: missing description for "${name}"`);
  }
  return description;
}

export class PromptNotFoundError extends Error {
  constructor(name: string) {
    super(`mcp-prompts: unknown prompt "${name}"`);
    this.name = "PromptNotFoundError";
  }
}

export class PromptArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptArgumentError";
  }
}

export function toolMessage(operationId: string, detail: string): McpPromptMessage {
  return message("assistant", `Call \`${operationId}\`: ${detail}`);
}

export function message(role: "user" | "assistant", text: string): McpPromptMessage {
  return { role, content: { type: "text", text } };
}

export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new PromptArgumentError(`mcp-prompts: argument "${name}" is required`);
  }
  return value;
}

export function operationIdFromMessage(entry: McpPromptMessage): string | null {
  const match = /^Call `([a-z][a-z0-9_]*)`:/.exec(entry.content.text);
  return match?.[1] ?? null;
}
