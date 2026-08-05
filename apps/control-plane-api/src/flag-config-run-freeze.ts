import { envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import {
  AVAILABILITY_FIELD,
  ROLLOUT_FIELD,
  TARGETING_FIELD,
} from "./flag-config-run-freeze-proposal";

/**
 * A live Run freezes the Flag Configuration fields it owns, in the Worker.
 *
 * This is the enforcement behind the "Controlled by Experiment X" lock, not a
 * decoration of it. ADR-0023 makes the Control Plane API Worker "the sole guardian
 * of every management invariant", so a lock that exists only in the panel is no
 * lock at all: the CLI and the MCP server reach the same route, and in an `allow`
 * Policy Environment there is no Approval gate standing in the way either.
 *
 * The write is refused rather than allowed-and-ignored even though a live Run
 * serves from its own frozen snapshot and could not be corrupted by it
 * (evaluate-path). An allowed write would be INVISIBLE while the Run lasted and
 * would then take effect the moment it ended — a change nobody re-authorized,
 * racing the post-Run rollout decision, with nothing in the audit trail
 * connecting the edit to the effect. A silent delayed action is the disguised
 * default ADR-0036 exists to ban.
 *
 * The kill switch is deliberately absent from every frozen set below. An operator
 * must always be able to turn a Flag off in an incident, and no Experiment
 * outranks that (ADR-0029, flag-editing-ux.md).
 *
 * WHERE this runs is the whole security property. The refusal belongs to the
 * WRITE, not to a route: `config-store-mutations.ts` and `config-store-*.ts` are
 * reached by the Configuration PATCH, the Targeting PUT, the Promotion POST, and
 * the `approve_and_apply` Review, and a guard bolted onto a subset of those doors
 * is a guard that the next door walks around. Every store method that can move a
 * frozen field calls `frozenWriteFailure` itself (see the sweep in
 * `flag-config-run-freeze-writer-sweep.test.ts`). The two route-level helpers
 * below are ORDERING, not coverage: they make the refusal land ahead of the
 * Policy gate so a change that can never apply never becomes a pending Approval
 * Request for someone to approve into a refusal.
 *
 * An approved proposal's freeze check uses the request's own `diff.entries`
 * (`flag-config-run-freeze-proposal.ts`), not a re-diff of the complete proposed
 * snapshot against live state — that second comparison was the SPL-304 false
 * `RUN_FROZEN` on fields the request never changed.
 */

interface LiveRunFreeze {
  experimentId: string;
  runId: string;
}

export interface FlagTarget {
  appId: string;
  environmentId: string;
  flagId: string;
}

/** The refusal as data, so the store can return it and the routes can render it. */
export interface RunFrozenFailure {
  ok: false;
  reason: "RUN_FROZEN";
  frozenFields: string[];
  currentRunId: string;
  attemptedChange: string;
}

/**
 * The one lookup every writer shares. Answers `null` when the write is free to
 * proceed, so no caller can accidentally read "not frozen" as a refusal.
 *
 * An empty `frozenFields` — a kill-switch-only patch — never reaches the query,
 * so incident control does not pay for an answer it would ignore.
 */
export async function frozenWriteFailure(
  repo: Repository,
  target: FlagTarget,
  frozenFields: string[],
  attemptedChange: string,
): Promise<RunFrozenFailure | null> {
  if (frozenFields.length === 0) return null;
  const freeze = await liveRunFreezeForFlag(repo, target);
  if (!freeze) return null;
  return {
    ok: false,
    reason: "RUN_FROZEN",
    frozenFields,
    currentRunId: freeze.runId,
    attemptedChange: `${attemptedChange}:${target.flagId}`,
  };
}

/**
 * Which fields of a Flag Configuration PATCH a live Run owns.
 *
 * `enabled` is never listed. The baseline `rollout` is: a live Run's allocation is
 * the authority for its traffic and the config baseline is explicitly not applied
 * while it runs (evaluate-path), so accepting one would confirm "applied" for a
 * change with zero effect on served traffic until the Run ended.
 */
export function frozenConfigFields(payload: {
  availableVariantNames?: unknown;
  rollout?: unknown;
}): string[] {
  const frozen: string[] = [];
  if (payload.availableVariantNames !== undefined) frozen.push(AVAILABILITY_FIELD);
  if (payload.rollout !== undefined) frozen.push(ROLLOUT_FIELD);
  return frozen;
}

export function frozenTargetingFields(): string[] {
  return [TARGETING_FIELD];
}

/**
 * A Promotion writes into the TARGET Environment, so it is the target's Run that
 * judges it, and `select` says exactly which fields it moves. `select.enabled`
 * alone moves nothing a Run owns and stays free.
 */
export function frozenPromotionFields(select: {
  availability?: string[];
  targeting?: true;
  rollout?: true;
}): string[] {
  const frozen: string[] = [];
  if (select.availability !== undefined) frozen.push(AVAILABILITY_FIELD);
  if (select.rollout) frozen.push(ROLLOUT_FIELD);
  if (select.targeting) frozen.push(TARGETING_FIELD);
  return frozen;
}

/**
 * Route-level ORDERING for the Configuration PATCH and the Targeting PUT: refuse
 * before the Policy gate can mint a proposal. The store refuses these same writes
 * again on the way to D1 — that second refusal, not this one, is the boundary.
 */
export async function flagConfigFreezeRefusal(
  repo: Repository,
  target: FlagTarget,
  payload: Record<string, unknown>,
  requestId: string,
): Promise<Response | null> {
  const failure = await frozenWriteFailure(
    repo,
    target,
    frozenConfigFields(payload),
    "PATCH_FLAG_CONFIG",
  );
  return failure ? runFrozenResponse(failure, requestId) : null;
}

export async function targetingFreezeRefusal(
  repo: Repository,
  target: FlagTarget,
  requestId: string,
): Promise<Response | null> {
  const failure = await frozenWriteFailure(
    repo,
    target,
    frozenTargetingFields(),
    "PUT_TARGETING_RULES",
  );
  return failure ? runFrozenResponse(failure, requestId) : null;
}

/**
 * The refusal, carrying the Run that owns the field and a remedy the operator can
 * actually perform. `END_RUNNING_RUN_FIRST` and not `CREATE_NEW_RUN`: opening a new
 * Run is the remedy for an Experiment assignment edit, and offering it here would
 * send the operator somewhere that does not change this Flag Configuration at all.
 */
export function runFrozenResponse(failure: RunFrozenFailure, requestId: string): Response {
  return renderError(runFrozenError(failure), { requestId });
}

export function runFrozenError(failure: RunFrozenFailure) {
  return {
    code: "RUN_FROZEN" as const,
    message: runFrozenMessage(failure.currentRunId),
    details: {
      frozenFields: failure.frozenFields,
      currentRunId: failure.currentRunId,
      attemptedChange: failure.attemptedChange,
      recommendedAction: "END_RUNNING_RUN_FIRST" as const,
    },
  };
}

function runFrozenMessage(runId: string): string {
  return `running Run ${runId} owns this Flag Configuration field; end it to change this`;
}

async function liveRunFreezeForFlag(
  repo: Repository,
  { appId, environmentId, flagId }: FlagTarget,
): Promise<LiveRunFreeze | null> {
  const scope = envScope(appId, environmentId);
  const experiment = await repo.experiments.findRunningExperimentForFlag(scope, flagId);
  if (!experiment) return null;

  const run =
    (experiment.liveRunId ? await repo.experiments.getRun(scope, experiment.liveRunId) : null) ??
    (await repo.experiments.findRunningRunForExperiment(scope, experiment.id));
  return {
    experimentId: experiment.id,
    // A running Experiment with no resolvable Run row is a broken invariant, not a
    // reason to let the write through: the refusal still stands and says so.
    runId: run?.id ?? experiment.liveRunId ?? "unknown",
  };
}
