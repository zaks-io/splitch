import type {
  EvaluationCommitOutbox,
  EvaluationCommitOutboxNamespace,
} from "./evaluation-commit-outbox";

interface EvaluationCommit {
  readonly eventId: string;
  readonly payload: unknown;
  readonly delivered: boolean;
}

export function evaluationCommitOutbox(
  binding: EvaluationCommitOutbox | EvaluationCommitOutboxNamespace | undefined,
): EvaluationCommitOutbox | undefined {
  if (binding === undefined) return undefined;
  return "commit" in binding ? binding : durableEvaluationCommitOutbox(binding);
}

function durableEvaluationCommitOutbox(
  namespace: EvaluationCommitOutboxNamespace,
): EvaluationCommitOutbox {
  return {
    async lookup(identity) {
      const response = await post(namespace, identity, "lookup", { identity });
      if (response.status === 404) return null;
      requireOk(response, "Evaluation commit outbox lookup");
      return parseEvaluationCommit(await response.json());
    },
    async commit(identity, payload) {
      const response = await post(namespace, identity, "commit", { identity, payload });
      requireOk(response, "Evaluation commit outbox");
      return parseEvaluationCommit(await response.json());
    },
    async acknowledge(identity) {
      const response = await post(namespace, identity, "acknowledge", { identity });
      requireOk(response, "Evaluation commit acknowledgement");
    },
    async privacyExport(identity, eventIds) {
      const response = await privacyRequest(namespace, identity, "privacy-export", eventIds);
      const result = (await response.json()) as { records?: unknown };
      if (!Array.isArray(result.records) || result.records.some((row) => !isRecord(row))) {
        throw new Error("Evaluation commit privacy export returned invalid records");
      }
      return result.records as Record<string, unknown>[];
    },
    async privacyDelete(identity, eventIds) {
      const response = await privacyRequest(namespace, identity, "privacy-delete", eventIds);
      const result = (await response.json()) as { deletedCount?: unknown };
      if (typeof result.deletedCount !== "number" || !Number.isInteger(result.deletedCount)) {
        throw new Error("Evaluation commit privacy deletion returned invalid proof");
      }
      return result.deletedCount;
    },
    async privacyDeleteAll(identity) {
      const response = await post(namespace, identity, "privacy-delete-all", { identity });
      requireOk(response, "Evaluation commit privacy-delete-all");
      const result = (await response.json()) as { proof?: unknown };
      if (result.proof !== "evaluation-commit-outbox-purged-v1") {
        throw new Error("Evaluation commit App deletion returned invalid proof");
      }
      return result.proof;
    },
  };
}

async function privacyRequest(
  namespace: EvaluationCommitOutboxNamespace,
  identity: string,
  operation: "privacy-export" | "privacy-delete",
  eventIds: readonly string[],
): Promise<Response> {
  const response = await post(namespace, identity, operation, { identity, eventIds });
  requireOk(response, `Evaluation commit ${operation}`);
  return response;
}

function post(
  namespace: EvaluationCommitOutboxNamespace,
  identity: string,
  operation: string,
  body: unknown,
): Promise<Response> {
  return namespace
    .get(namespace.idFromName(identity))
    .fetch(`https://evaluation-commit-outbox.local/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

function requireOk(response: Response, operation: string): void {
  if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}`);
}

function parseEvaluationCommit(body: unknown): EvaluationCommit {
  const commit = body as Partial<EvaluationCommit>;
  if (
    typeof commit.eventId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(commit.eventId) ||
    commit.payload === undefined ||
    typeof commit.delivered !== "boolean"
  ) {
    throw new Error("Evaluation commit outbox returned an invalid commit");
  }
  return commit as EvaluationCommit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
