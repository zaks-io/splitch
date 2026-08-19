import { assignmentWriterName, type HashedAssignmentPutInput } from "./assignment-store";
import {
  ensureHoldoverWriteJob,
  HOLDOVER_WRITE_JOB_KEY,
  type HoldoverWriteEnsureResult,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxLogger,
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  holdoverWriteOutboxName,
  runHoldoverWriteAlarm,
} from "./holdover-write-outbox-core";
import type { AssignmentWriterNamespace } from "./kv-assignment-store";

export interface HoldoverWriteOutboxNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export interface HoldoverWriteCoordinator {
  /**
   * Either completes `putHashed` or durably owns retry work before resolving.
   * Rejects when ownership cannot be sealed (caller must not report `accepted`).
   */
  ensure(input: HashedAssignmentPutInput): Promise<HoldoverWriteEnsureResult>;
}

class HoldoverWriteOutboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HoldoverWriteOutboxError";
  }
}

/**
 * Direct put for unit harnesses without a Durable Object. Failures reject so
 * the route cannot acknowledge `accepted` without durable ownership.
 */
export class DirectHoldoverWriteCoordinator implements HoldoverWriteCoordinator {
  constructor(
    private readonly putPort: HoldoverWritePutPort,
    private readonly logger?: HoldoverWriteOutboxLogger,
  ) {}

  async ensure(input: HashedAssignmentPutInput): Promise<HoldoverWriteEnsureResult> {
    try {
      await this.putPort.putHashed(input);
      return { status: "completed" };
    } catch (cause) {
      this.logger?.error("holdover_write_put_failed_without_outbox", {
        appId: input.appId,
        experimentId: input.experimentId,
        idType: input.idType,
        targetingKeyHash: input.targetingKeyHash,
        runId: input.runId,
        variant: input.variant,
        cause,
      });
      throw cause instanceof Error ? cause : new HoldoverWriteOutboxError(String(cause), { cause });
    }
  }
}

/** In-memory outbox for tests that need failure-then-retry without Miniflare. */
export class MemoryHoldoverWriteCoordinator implements HoldoverWriteCoordinator {
  private readonly jobs = new Map<string, HoldoverWriteJob>();

  constructor(
    private readonly putPort: HoldoverWritePutPort,
    private readonly logger?: HoldoverWriteOutboxLogger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  ensure(input: HashedAssignmentPutInput): Promise<HoldoverWriteEnsureResult> {
    return ensureHoldoverWriteJob(
      this.storageFor(input),
      this.putPort,
      input,
      this.now(),
      this.logger,
    );
  }

  /** Drive one alarm tick for the named job (test seam). */
  alarm(input: HashedAssignmentPutInput): Promise<void> {
    return runHoldoverWriteAlarm(this.storageFor(input), this.putPort, this.now(), this.logger);
  }

  private storageFor(input: HashedAssignmentPutInput): HoldoverWriteOutboxStorage {
    const key = holdoverWriteOutboxName(input);
    const jobs = this.jobs;
    return {
      async get<T>(_storageKey: string): Promise<T | undefined> {
        return jobs.get(key) as T | undefined;
      },
      async put(_storageKey, value) {
        jobs.set(key, value as HoldoverWriteJob);
      },
      async delete(): Promise<boolean | undefined> {
        const had = jobs.has(key);
        jobs.delete(key);
        return had;
      },
      async setAlarm() {},
      async deleteAlarm() {},
    };
  }
}

/**
 * Durable Object-backed coordinator: seals retry ownership in DO storage, then
 * writes through Assignment Store Writer (putIfAbsent).
 */
export class DurableHoldoverWriteCoordinator implements HoldoverWriteCoordinator {
  constructor(private readonly namespace: HoldoverWriteOutboxNamespace) {}

  async ensure(input: HashedAssignmentPutInput): Promise<HoldoverWriteEnsureResult> {
    const name = holdoverWriteOutboxName(input);
    const stub = this.namespace.get(this.namespace.idFromName(name));
    let response: Response;
    try {
      response = await stub.fetch("https://holdover-write-outbox.local/ensure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch (cause) {
      throw new HoldoverWriteOutboxError("holdover write outbox transport failed", { cause });
    }
    if (!response.ok) {
      throw new HoldoverWriteOutboxError(`holdover write outbox returned HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new HoldoverWriteOutboxError("holdover write outbox returned invalid JSON", { cause });
    }
    return parseEnsureResult(body);
  }
}

function parseEnsureResult(value: unknown): HoldoverWriteEnsureResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    (value.status !== "completed" && value.status !== "owned" && value.status !== "poisoned")
  ) {
    throw new HoldoverWriteOutboxError("holdover write outbox returned an invalid ensure result");
  }
  return { status: value.status };
}

export interface HoldoverWriteOutboxEnv {
  ASSIGNMENT_STORE_WRITER: AssignmentWriterNamespace;
}

export async function handleHoldoverWriteOutboxFetch(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  request: Request,
  logger?: HoldoverWriteOutboxLogger,
  nowMs: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/status") {
    const job = await storage.get<HoldoverWriteJob>(HOLDOVER_WRITE_JOB_KEY);
    return Response.json(job ?? { status: "empty" });
  }
  if (request.method !== "POST" || url.pathname !== "/ensure") {
    return new Response("not found", { status: 404 });
  }
  const input = parseEnsureRequest(await request.json());
  const result = await ensureHoldoverWriteJob(storage, putPort, input, nowMs, logger);
  return Response.json(result);
}

function parseEnsureRequest(value: unknown): HashedAssignmentPutInput {
  if (!isRecord(value)) {
    throw new TypeError("holdover-write-outbox: expected object payload");
  }
  const input = {
    appId: requireString(value, "appId"),
    experimentId: requireString(value, "experimentId"),
    idType: requireString(value, "idType"),
    targetingKeyHash: requireString(value, "targetingKeyHash"),
    runId: requireString(value, "runId"),
    variant: requireString(value, "variant"),
  };
  const extra = Object.keys(value).filter((key) => !(key in input));
  if (extra.length > 0) {
    throw new TypeError(`holdover-write-outbox: unexpected payload keys ${extra.join(",")}`);
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`holdover-write-outbox: ${key} must be a non-empty string`);
  }
  return field;
}

export function assignmentWriterPutPort(
  namespace: AssignmentWriterNamespace,
): HoldoverWritePutPort {
  return {
    async putHashed(input) {
      const id = namespace.idFromName(assignmentWriterName(input));
      const stub = namespace.get(id);
      const response = await stub.fetch("https://assignment-store.local/put", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: input.appId,
          experimentId: input.experimentId,
          idType: input.idType,
          targetingKeyHash: input.targetingKeyHash,
          runId: input.runId,
          variant: input.variant,
        }),
      });
      if (!response.ok) {
        throw new HoldoverWriteOutboxError(`Assignment writer DO returned ${response.status}`);
      }
      await response.json();
    },
  };
}
