import {
  type IngestAdmissionBudget,
  type IngestStream,
  ingestAdmissionBudget,
  ingestAdmissionScopeName,
} from "./ingest-admission-config";
import type { Env } from "./types";

export interface IngestAdmissionGateNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export interface AdmissionDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export interface AdmissionCost {
  readonly rowCost: number;
  readonly byteCost: number;
}

export interface AdmissionBucketState {
  readonly rowTokens: number;
  readonly byteTokens: number;
  readonly updatedAt: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS admission_buckets (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  row_tokens REAL NOT NULL,
  byte_tokens REAL NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/**
 * One SQLite-backed token-bucket pair per `(app_id, environment_id, ingest_stream)`.
 * Both deductions commit together or neither bucket changes.
 */
export class IngestAdmissionGateDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {
    this.ctx.storage.sql.exec(SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const input = await parseAdmissionRequest(request);
    if (input === null) return new Response("invalid admission request", { status: 400 });

    const decision = this.ctx.storage.transactionSync(() => {
      const current = this.read();
      const evaluated = evaluateAdmission(current, Date.now(), input.budget, input.cost);
      if (evaluated.decision.allowed && shouldPersist(current, evaluated.next, input.cost)) {
        this.write(evaluated.next);
      }
      return evaluated.decision;
    });
    return Response.json(decision);
  }

  private read(): AdmissionBucketState | null {
    const row = this.ctx.storage.sql
      .exec<{ row_tokens: number; byte_tokens: number; updated_at: number }>(
        "SELECT row_tokens, byte_tokens, updated_at FROM admission_buckets WHERE id = 1",
      )
      .toArray()[0];
    if (row === undefined) return null;
    return {
      rowTokens: row.row_tokens,
      byteTokens: row.byte_tokens,
      updatedAt: row.updated_at,
    };
  }

  private write(state: AdmissionBucketState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO admission_buckets (id, row_tokens, byte_tokens, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         row_tokens = excluded.row_tokens,
         byte_tokens = excluded.byte_tokens,
         updated_at = excluded.updated_at`,
      state.rowTokens,
      state.byteTokens,
      state.updatedAt,
    );
  }
}

export function evaluateAdmission(
  state: AdmissionBucketState | null,
  now: number,
  budget: IngestAdmissionBudget,
  cost: AdmissionCost,
): { decision: AdmissionDecision; next: AdmissionBucketState } {
  const refilled = refillBuckets(state, now, budget);
  if (cost.rowCost === 0 && cost.byteCost === 0) {
    return { decision: { allowed: true, retryAfterMs: 0 }, next: refilled };
  }

  if (refilled.rowTokens >= cost.rowCost && refilled.byteTokens >= cost.byteCost) {
    return {
      decision: { allowed: true, retryAfterMs: 0 },
      next: {
        rowTokens: refilled.rowTokens - cost.rowCost,
        byteTokens: refilled.byteTokens - cost.byteCost,
        updatedAt: refilled.updatedAt,
      },
    };
  }

  return {
    decision: {
      allowed: false,
      retryAfterMs: Math.max(
        waitMs(refilled.rowTokens, cost.rowCost, budget.rowsPerSecond),
        waitMs(refilled.byteTokens, cost.byteCost, budget.bytesPerSecond),
      ),
    },
    next: state ?? initialBuckets(now, budget),
  };
}

export function queuePayloadBytes(row: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(row)).byteLength;
}

export async function chargeIngestAdmission(
  namespace: IngestAdmissionGateNamespace | undefined,
  scope: {
    readonly appId: string;
    readonly environmentId: string;
    readonly ingestStream: IngestStream;
  },
  cost: AdmissionCost,
): Promise<AdmissionDecision> {
  if (!namespace) throw new Error("INGEST_ADMISSION_GATE binding is unavailable");
  const budget = ingestAdmissionBudget(scope.ingestStream);
  const name = ingestAdmissionScopeName(scope.appId, scope.environmentId, scope.ingestStream);
  const response = await namespace
    .get(namespace.idFromName(name))
    .fetch("https://ingest-admission.local/charge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cost, budget }),
    });
  if (!response.ok) throw new Error(`Ingest Admission Gate returned HTTP ${response.status}`);
  return parseAdmissionDecision(await response.json());
}

/**
 * Allowed decisions carry a zero retry; denials carry a positive finite delay.
 * Any other pairing, a negative delay, or a non-finite delay is invalid.
 */
function parseAdmissionDecision(body: unknown): AdmissionDecision {
  if (typeof body !== "object" || body === null) {
    throw new Error("Ingest Admission Gate returned an invalid decision");
  }
  const allowed = "allowed" in body ? body.allowed : undefined;
  const retryAfterMs = "retryAfterMs" in body ? body.retryAfterMs : undefined;
  if (
    typeof allowed !== "boolean" ||
    !isNonNegative(retryAfterMs) ||
    allowed !== (retryAfterMs === 0)
  ) {
    throw new Error("Ingest Admission Gate returned an invalid decision");
  }
  return { allowed, retryAfterMs };
}

function refillBuckets(
  state: AdmissionBucketState | null,
  now: number,
  budget: IngestAdmissionBudget,
): AdmissionBucketState {
  if (state === null) return initialBuckets(now, budget);
  const elapsedMs = Math.max(0, now - state.updatedAt);
  return {
    rowTokens: refill(state.rowTokens, budget.rowBurstCapacity, budget.rowsPerSecond, elapsedMs),
    byteTokens: refill(
      state.byteTokens,
      budget.byteBurstCapacity,
      budget.bytesPerSecond,
      elapsedMs,
    ),
    updatedAt: now,
  };
}

function initialBuckets(now: number, budget: IngestAdmissionBudget): AdmissionBucketState {
  return {
    rowTokens: budget.rowBurstCapacity,
    byteTokens: budget.byteBurstCapacity,
    updatedAt: now,
  };
}

function refill(tokens: number, capacity: number, rate: number, elapsedMs: number): number {
  return Math.min(capacity, tokens + (elapsedMs * rate) / 1_000);
}

function waitMs(tokens: number, cost: number, rate: number): number {
  if (tokens >= cost) return 0;
  if (rate <= 0) return 1_000;
  return Math.ceil(((cost - tokens) / rate) * 1_000);
}

function shouldPersist(
  current: AdmissionBucketState | null,
  next: AdmissionBucketState,
  cost: AdmissionCost,
): boolean {
  if (cost.rowCost === 0 && cost.byteCost === 0) return false;
  return (
    current === null ||
    current.rowTokens !== next.rowTokens ||
    current.byteTokens !== next.byteTokens ||
    current.updatedAt !== next.updatedAt
  );
}

async function parseAdmissionRequest(
  request: Request,
): Promise<{ budget: IngestAdmissionBudget; cost: AdmissionCost } | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const budget = body.budget as IngestAdmissionBudget | undefined;
    const rowCost = body.rowCost;
    const byteCost = body.byteCost;
    if (!isCompleteBudget(budget) || !isNonNegative(rowCost) || !isNonNegative(byteCost)) {
      return null;
    }
    return { budget, cost: { rowCost, byteCost } };
  } catch {
    return null;
  }
}

function isCompleteBudget(
  budget: IngestAdmissionBudget | undefined,
): budget is IngestAdmissionBudget {
  return (
    budget !== undefined &&
    isPositive(budget.rowsPerSecond) &&
    isPositive(budget.rowBurstCapacity) &&
    isPositive(budget.bytesPerSecond) &&
    isPositive(budget.byteBurstCapacity)
  );
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
