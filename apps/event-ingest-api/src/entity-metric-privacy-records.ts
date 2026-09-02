import {
  type EntityEvaluationInventoryEntry,
  type EntityMetricInventoryEntry,
  evaluationEntryGroups,
} from "./entity-metric-privacy";
import { evaluationCommitOutbox } from "./evaluation-commit-outbox-client";
import type { Env } from "./types";

/**
 * The whole-inventory halves of the Entity privacy authority: export what an
 * Entity's records say, and redact them. Both walk every outbox record the
 * inventory names, which is why the store runs them exclusively.
 */
export async function exportMetricRecords(
  env: Env,
  entries: readonly EntityMetricInventoryEntry[],
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const response = await outbox(env, entry.dedupKey).fetch(
      "https://metric-event-outbox.local/export",
    );
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new Error(`Metric Event outbox export returned HTTP ${response.status}`);
    }
    appendMetricExport(
      records,
      (await response.json()) as {
        deleted?: unknown;
        row?: unknown;
        activationRows?: unknown;
      },
    );
  }
  return records;
}

function appendMetricExport(
  records: Record<string, unknown>[],
  exported: { deleted?: unknown; row?: unknown; activationRows?: unknown },
): void {
  if (exported.deleted !== true && !isRecord(exported.row)) {
    throw new Error("Metric Event outbox export returned an invalid record");
  }
  if (isRecord(exported.row)) records.push(exported.row);
  if (exported.activationRows === undefined) return;
  if (!Array.isArray(exported.activationRows)) {
    throw new Error("Metric Event outbox export returned invalid Activation records");
  }
  for (const row of exported.activationRows) {
    if (!isRecord(row)) {
      throw new Error("Metric Event outbox export returned an invalid Activation record");
    }
    records.push(row);
  }
}

export async function exportEvaluationRecords(
  env: Env,
  entries: readonly EntityEvaluationInventoryEntry[],
): Promise<Record<string, unknown>[]> {
  const records = [];
  for (const [identity, eventIds] of evaluationEntryGroups(entries)) {
    records.push(...(await evaluationOutbox(env).privacyExport(identity, eventIds)));
  }
  return records;
}

export async function deleteMetricRecords(
  env: Env,
  entries: readonly EntityMetricInventoryEntry[],
): Promise<number> {
  let deletedCount = 0;
  for (const entry of entries) {
    const response = await outbox(env, entry.dedupKey).fetch(
      "https://metric-event-outbox.local/suppress",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      },
    );
    if (!response.ok) {
      // The body says whether the record refused because a delivery is still in
      // flight, which is the difference between "retry me" and a real fault.
      throw new Error(
        `Metric Event outbox deletion returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const result = (await response.json()) as { deleted?: unknown; proof?: unknown };
    if (result.deleted !== true || typeof result.proof !== "string" || result.proof.length === 0) {
      throw new Error("Metric Event outbox deletion omitted its proof");
    }
    deletedCount += 1;
  }
  return deletedCount;
}

export async function deleteEvaluationRecords(
  env: Env,
  entries: readonly EntityEvaluationInventoryEntry[],
): Promise<number> {
  let deletedCount = 0;
  for (const [identity, eventIds] of evaluationEntryGroups(entries)) {
    deletedCount += await evaluationOutbox(env).privacyDelete(identity, eventIds);
  }
  return deletedCount;
}

function outbox(env: Env, dedupKey: string) {
  const namespace = env.METRIC_EVENT_OUTBOX;
  if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
  return namespace.get(namespace.idFromName(dedupKey));
}

function evaluationOutbox(env: Env) {
  const outboxClient = evaluationCommitOutbox(env.EVALUATION_COMMIT_OUTBOX);
  if (!outboxClient) throw new Error("EVALUATION_COMMIT_OUTBOX binding is unavailable");
  return outboxClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
