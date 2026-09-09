import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { idempotencyConflict } from "./approval-review-outcomes";
import { targetConfigurationStale } from "./experiment-conclusion-errors";
import { runNotRunning } from "./experiment-errors";
import type { ExperimentDeps } from "./experiment-handler-shared";

type ConclusionReplay = NonNullable<
  Awaited<ReturnType<ExperimentDeps["repo"]["experimentConclusions"]["getByActorKey"]>>
>;
type ReplacementReplay = NonNullable<
  Awaited<ReturnType<ExperimentDeps["repo"]["approvals"]["getRequestByActorKey"]>>
>;

export type ConclusionGuardResolution =
  | { kind: "replay"; conclusion: ConclusionReplay }
  | { kind: "response"; response: Response };

export type ReplacementGuardResolution =
  | { kind: "replay"; approval: ReplacementReplay }
  | { kind: "response"; response: Response };

interface TargetGuard {
  appId: string;
  targetEnvironmentId: string;
  flagId: string;
  expectedConfigVersion: number;
}

interface ConclusionGuardInput extends TargetGuard {
  environmentId: string;
  experimentId: string;
  runId: string;
  idempotencyKey: string;
  requestHash: string;
}

interface ReplacementGuardInput extends TargetGuard {
  conclusionId: string;
  idempotencyKey: string;
  requestHash: string;
}

export async function resolveConclusionGuardFailure(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  input: ConclusionGuardInput,
  cause: unknown,
): Promise<ConclusionGuardResolution> {
  const replay = await deps.repo.experimentConclusions.getByActorKey(
    appScope(input.appId),
    args.principal.id,
    input.idempotencyKey,
  );
  if (replay) {
    return replay.requestHash === input.requestHash
      ? { kind: "replay", conclusion: replay }
      : {
          kind: "response",
          response: idempotencyConflict("conclusion", input.idempotencyKey, args.requestId),
        };
  }

  const adminError = await requireAppAdmin(deps, input.appId, args.principal, args.requestId);
  if (adminError) return { kind: "response", response: adminError };

  const scope = envScope(input.appId, input.environmentId);
  const [run, experiment] = await Promise.all([
    deps.repo.experiments.getRun(scope, input.runId),
    deps.repo.experiments.getExperiment(scope, input.experimentId),
  ]);
  if (run && (run.status !== "running" || !experiment || experiment.liveRunId !== input.runId)) {
    return { kind: "response", response: runNotRunning(input.runId, args.requestId) };
  }

  const stale = await freshTargetError(deps, args.requestId, input);
  if (stale) return { kind: "response", response: stale };
  throw cause;
}

export async function resolveReplacementGuardFailure(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
  input: ReplacementGuardInput,
  cause: unknown,
): Promise<ReplacementGuardResolution> {
  const replay = await deps.repo.approvals.getRequestByActorKey(
    appScope(input.appId),
    args.principal.id,
    input.idempotencyKey,
  );
  if (replay) {
    if (replay.requestHash !== input.requestHash) {
      return {
        kind: "response",
        response: idempotencyConflict("approval_request", input.idempotencyKey, args.requestId),
      };
    }
    const links = await deps.repo.experimentConclusions.listApprovalLinks(
      appScope(input.appId),
      input.conclusionId,
    );
    return links.some((link) => link.approvalRequestId === replay.id)
      ? { kind: "replay", approval: replay }
      : {
          kind: "response",
          response: idempotencyConflict("approval_request", input.idempotencyKey, args.requestId),
        };
  }

  const adminError = await requireAppAdmin(deps, input.appId, args.principal, args.requestId);
  if (adminError) return { kind: "response", response: adminError };

  const stale = await freshTargetError(deps, args.requestId, input);
  if (stale) return { kind: "response", response: stale };
  throw cause;
}

async function freshTargetError(
  deps: ExperimentDeps,
  requestId: string,
  target: TargetGuard,
): Promise<Response | null> {
  const current = await deps.repo.flags.getFlagConfig(
    envScope(target.appId, target.targetEnvironmentId),
    target.flagId,
  );
  if (!current || current.version === target.expectedConfigVersion) return null;
  return targetConfigurationStale(
    target.flagId,
    target.targetEnvironmentId,
    target.expectedConfigVersion,
    current.version,
    requestId,
  );
}
