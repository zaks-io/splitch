import { and, eq } from "drizzle-orm";
import { experiments, runs } from "../schema/index";
import type { ApprovalCommit } from "./approval-types";
import { approvalAppliedStatements } from "./experiment-start-approval";
import {
  endCurrentRunStatement,
  hasExpectedDraft,
  insertRunStatement,
  startGuardParams,
  updateExperimentStartedStatement,
} from "./experiment-start-run-sql";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";
import type { ScopedTable } from "./scoped-table";

type ExperimentRow = typeof experiments.$inferSelect;
type RunRow = typeof runs.$inferSelect;
type RunInsert = typeof runs.$inferInsert;

export type StartRunExpectedDraft = Pick<
  ExperimentRow,
  "draftAllocation" | "draftSalt" | "draftTargetingRules" | "draftSegmentIds" | "liveRunId"
> & { defaultVariantId: string };

export type StartRunInput = {
  experimentId: string;
  flagId: string;
  expectedDraft: StartRunExpectedDraft;
  run: Omit<
    RunInsert,
    "appId" | "environmentId" | "experimentId" | "runNumber" | "status" | "controlVariantId"
  > &
    // `horizon` has a column default, which would make it optional here and let a
    // caller register a stopping rule it never chose. The Run is the only home
    // for it (ADR-0014), so Start must state it (ADR-0036).
    Required<Pick<RunInsert, "horizon">>;
  endedAt: string;
  updatedAt: string;
  updatedBy?: string | null;
  approval?: ApprovalCommit;
};

export type StartRunResult =
  | { ok: true; run: RunRow; previous: RunRow | null }
  | { ok: false; reason: "experiment_not_found" | "stale_draft" };

export function makeStartRun(
  d1: D1Database,
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
) {
  return async function startRun(scope: EnvScope, input: StartRunInput): Promise<StartRunResult> {
    assertMintedScope(scope);
    assertControlInFrozenVariantSet(input.expectedDraft.defaultVariantId, input.run.variantSet);
    const state = await loadStartState(experimentsTable, runsTable, scope, input);
    if (!state.ok) return state;

    const committed = await runStartBatch(d1, scope, input);
    if (!committed) return { ok: false, reason: "stale_draft" };

    const run = await runsTable.findOne(scope, eq(runs.id, input.run.id));
    if (!run) throw new Error("startRun: committed Run could not be reloaded");
    const previous = state.previous
      ? await runsTable.findOne(scope, eq(runs.id, state.previous.id))
      : null;
    return { ok: true, run, previous: previous ?? state.previous };
  };
}

function assertControlInFrozenVariantSet(controlVariantId: string, variantSetJson: string): void {
  let variantSet: unknown;
  try {
    variantSet = JSON.parse(variantSetJson);
  } catch {
    throw new Error("startRun: frozen Variant set is not valid JSON");
  }
  if (
    !Array.isArray(variantSet) ||
    !variantSet.some(
      (variant) =>
        typeof variant === "object" &&
        variant !== null &&
        "id" in variant &&
        variant.id === controlVariantId,
    )
  ) {
    throw new Error(
      `startRun: Control Variant ${controlVariantId} is absent from the frozen Variant set`,
    );
  }
}

async function loadStartState(
  experimentsTable: ScopedTable<typeof experiments>,
  runsTable: ScopedTable<typeof runs>,
  scope: EnvScope,
  input: StartRunInput,
): Promise<
  | { ok: true; previous: RunRow | null }
  | { ok: false; reason: "experiment_not_found" | "stale_draft" }
> {
  const current = await experimentsTable.findOne(scope, eq(experiments.id, input.experimentId));
  if (!current) return { ok: false, reason: "experiment_not_found" };
  if (!hasExpectedDraft(current, input.expectedDraft)) {
    return { ok: false, reason: "stale_draft" };
  }

  const runningRows = await runsTable.findMany(
    scope,
    and(eq(runs.experimentId, input.experimentId), eq(runs.status, "running")),
  );
  if (runningRows.length > 1) {
    throw new Error("startRun: multiple running Runs for one Experiment");
  }
  return { ok: true, previous: runningRows[0] ?? null };
}

async function runStartBatch(
  d1: D1Database,
  scope: EnvScope,
  input: StartRunInput,
): Promise<boolean> {
  const guardParams = startGuardParams(scope, input);
  const batch = await d1.batch([
    endCurrentRunStatement(d1, scope, input, guardParams),
    insertRunStatement(d1, scope, input, guardParams),
    updateExperimentStartedStatement(d1, input, guardParams),
    ...(input.approval ? approvalAppliedStatements(d1, scope, input.approval, input.run.id) : []),
  ]);
  const inserted = batch[1]?.results ?? [];
  const updated = batch[2]?.results ?? [];
  if (inserted.length === 0 && updated.length === 0) return false;
  if (inserted.length !== 1 || updated.length !== 1) {
    throw new Error("startRun: guarded D1 batch produced an inconsistent result");
  }
  // The Approval statements are appended to this same batch but were never
  // inspected, so a Run could start while its Approval Request stayed pending
  // and the caller was still told `ok`. This is the `approvalReviewLanded`
  // equivalent every other Approval write path already has; here the Review
  // insert RETURNs its id, so the evidence is in the batch result itself.
  if (input.approval && (batch[3]?.results ?? []).length !== 1) {
    throw new Error("startRun: the Run started but its Approval Review did not land");
  }
  return true;
}
