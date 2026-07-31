import { envScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";

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

/**
 * The two entry points the routes call. Both answer `null` when the write is free
 * to proceed, so a caller cannot accidentally treat "not frozen" as a refusal.
 *
 * A Configuration PATCH that touches no frozen field — a kill switch flip — never
 * reaches the lookup, so incident control does not pay for a query whose answer it
 * would ignore.
 */
export async function flagConfigFreezeRefusal(
  repo: Repository,
  target: FlagTarget,
  payload: Record<string, unknown>,
  requestId: string,
): Promise<Response | null> {
  return refusal(repo, target, frozenConfigFields(payload), "PATCH_FLAG_CONFIG", requestId);
}

export function targetingFreezeRefusal(
  repo: Repository,
  target: FlagTarget,
  requestId: string,
): Promise<Response | null> {
  return refusal(repo, target, frozenTargetingFields(), "PUT_TARGETING_RULES", requestId);
}

async function refusal(
  repo: Repository,
  target: FlagTarget,
  frozenFields: string[],
  attemptedChange: string,
  requestId: string,
): Promise<Response | null> {
  if (frozenFields.length === 0) return null;
  const freeze = await liveRunFreezeForFlag(repo, target);
  if (!freeze) return null;
  return flagConfigRunFrozen(
    freeze,
    frozenFields,
    `${attemptedChange}:${target.flagId}`,
    requestId,
  );
}

/** Names match the wire fields an operator is refused, so the error is self-locating. */
const AVAILABILITY_FIELD = "flagConfig.availableVariantNames";
const ROLLOUT_FIELD = "flagConfig.rollout";
const TARGETING_FIELD = "flagConfig.targetingRules";

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

/**
 * Which fields of a Flag Configuration PATCH a live Run owns.
 *
 * `enabled` is never listed. The baseline `rollout` is: a live Run's allocation is
 * the authority for its traffic and the config baseline is explicitly not applied
 * while it runs (evaluate-path), so accepting one would confirm "applied" for a
 * change with zero effect on served traffic until the Run ended.
 */
function frozenConfigFields(payload: Record<string, unknown>): string[] {
  const frozen: string[] = [];
  if (payload.availableVariantNames !== undefined) frozen.push(AVAILABILITY_FIELD);
  if (payload.rollout !== undefined) frozen.push(ROLLOUT_FIELD);
  return frozen;
}

function frozenTargetingFields(): string[] {
  return [TARGETING_FIELD];
}

/**
 * The refusal, carrying the Run that owns the field and a remedy the operator can
 * actually perform. `END_RUNNING_RUN_FIRST` and not `CREATE_NEW_RUN`: opening a new
 * Run is the remedy for an Experiment assignment edit, and offering it here would
 * send the operator somewhere that does not change this Flag Configuration at all.
 */
function flagConfigRunFrozen(
  freeze: LiveRunFreeze,
  frozenFields: string[],
  attemptedChange: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "RUN_FROZEN",
      message: `running Run ${freeze.runId} owns this Flag Configuration field; end it to change this`,
      details: {
        frozenFields,
        currentRunId: freeze.runId,
        attemptedChange,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    },
    { requestId },
  );
}
