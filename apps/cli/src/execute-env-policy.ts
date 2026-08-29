import type { ResolvedContext } from "./context.js";
import { writeCliError } from "./errors.js";
import { executeApiOperation } from "./execute-operations.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { environmentSelectorOverride } from "./operation-input.js";
import type { ParsedInvocation } from "./parse-args.js";

export async function executeEnvPolicyGet(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  return executeApiOperation(
    "environments_get",
    {
      appId: context.appId,
      environmentId: context.environmentId,
      ...environmentSelectorOverride(invocation.flags.by),
    },
    invocation,
    deps,
    io,
    (data) => ({ policy: (data as { policy: unknown }).policy }),
  );
}

export async function executeEnvPolicySet(
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  if (!invocation.flags.bodyJson) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary: "env-policy set requires --body-json",
      remediation: "Pass the Environment Policy JSON object with --body-json",
    });
    return { exitCode: EXIT_USAGE };
  }
  const policy = JSON.parse(invocation.flags.bodyJson) as unknown;
  return executeApiOperation(
    "environments_update",
    {
      appId: context.appId,
      environmentId: context.environmentId,
      ...environmentSelectorOverride(invocation.flags.by),
      policy,
    },
    invocation,
    deps,
    io,
    (data) => ({ policy: (data as { policy: unknown }).policy }),
  );
}
