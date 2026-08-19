import type { AssignmentKv } from "./assignment-store";
import { assignmentWriterName, type HashedAssignmentPutInput } from "./assignment-store";
import {
  appHoldoverWriteSuppressKey,
  ensureHoldoverWriteJob,
  HOLDOVER_WRITE_JOB_PREFIX,
  type HoldoverWriteEnsureResult,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxLogger,
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  type HoldoverWriteSuppressionPort,
  holdoverWriteOutboxName,
  purgeEntityOutboxState,
  runHoldoverWriteAlarm,
  suppressEntityOutbox,
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
   * Either completes `putHashed` (KV-visible) or durably owns retry work before
   * resolving. Rejects when ownership cannot be sealed (caller must not report
   * `accepted`). May resolve `poisoned` / `suppressed` for the route to fail-loud
   * or skip writes.
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
  private readonly entities = new Map<string, Map<string, unknown>>();
  private appSuppressed = new Set<string>();

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
      this.suppressionPort(),
    );
  }

  /** Drive one alarm tick for the Entity outbox (test seam). */
  alarm(input: HashedAssignmentPutInput): Promise<void> {
    return runHoldoverWriteAlarm(
      this.storageFor(input),
      this.putPort,
      this.now(),
      this.logger,
      this.suppressionPort(),
    );
  }

  /** Test / deletion seam: mark the Entity outbox suppressed. */
  suppressEntity(input: HashedAssignmentPutInput): Promise<void> {
    return suppressEntityOutbox(this.storageFor(input));
  }

  /** Test / deletion seam: purge pending/poisoned jobs for the Entity. */
  purgeEntity(input: HashedAssignmentPutInput): Promise<void> {
    return purgeEntityOutboxState(this.storageFor(input));
  }

  /** Test seam: App-wide deletion suppress tombstone. */
  suppressApp(appId: string): void {
    this.appSuppressed.add(appId);
  }

  /** Inspect durable job state for tests. */
  jobFor(input: HashedAssignmentPutInput): HoldoverWriteJob | undefined {
    const bucket = this.entities.get(holdoverWriteOutboxName(input));
    return bucket?.get(`${HOLDOVER_WRITE_JOB_PREFIX}${input.experimentId}`) as
      | HoldoverWriteJob
      | undefined;
  }

  private suppressionPort(): HoldoverWriteSuppressionPort {
    return {
      isAppSuppressed: async (appId) => this.appSuppressed.has(appId),
    };
  }

  private storageFor(input: HashedAssignmentPutInput): HoldoverWriteOutboxStorage {
    const entity = holdoverWriteOutboxName(input);
    let bucket = this.entities.get(entity);
    if (bucket === undefined) {
      bucket = new Map();
      this.entities.set(entity, bucket);
    }
    const store = bucket;
    return {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key): Promise<boolean | undefined> {
        const had = store.has(key);
        store.delete(key);
        return had;
      },
      async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
        const out = new Map<string, T>();
        for (const [key, value] of store) {
          if (options?.prefix === undefined || key.startsWith(options.prefix)) {
            out.set(key, value as T);
          }
        }
        return out;
      },
      async setAlarm() {},
      async deleteAlarm() {},
    };
  }
}

/**
 * Durable Object-backed coordinator: seals retry ownership in DO storage, then
 * writes through Assignment Store Writer (putIfAbsent) until KV-complete.
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

  async suppressEntity(input: HashedAssignmentPutInput): Promise<void> {
    await this.postPath(input, "/suppress");
  }

  async purgeEntity(input: HashedAssignmentPutInput): Promise<void> {
    await this.postPath(input, "/purge");
  }

  private async postPath(
    input: HashedAssignmentPutInput,
    path: "/suppress" | "/purge",
  ): Promise<void> {
    const name = holdoverWriteOutboxName(input);
    const stub = this.namespace.get(this.namespace.idFromName(name));
    const response = await stub.fetch(`https://holdover-write-outbox.local${path}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new HoldoverWriteOutboxError(
        `holdover write outbox ${path} returned HTTP ${response.status}`,
      );
    }
  }
}

function parseEnsureResult(value: unknown): HoldoverWriteEnsureResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    (value.status !== "completed" &&
      value.status !== "owned" &&
      value.status !== "poisoned" &&
      value.status !== "suppressed")
  ) {
    throw new HoldoverWriteOutboxError("holdover write outbox returned an invalid ensure result");
  }
  return { status: value.status };
}

export interface HoldoverWriteOutboxEnv {
  ASSIGNMENT_STORE_WRITER: AssignmentWriterNamespace;
  ASSIGNMENTS_KV: AssignmentKv;
}

export async function handleHoldoverWriteOutboxFetch(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  request: Request,
  logger?: HoldoverWriteOutboxLogger,
  nowMs: number = Date.now(),
  suppression?: HoldoverWriteSuppressionPort,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/suppress") {
    await suppressEntityOutbox(storage);
    return Response.json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/purge") {
    await purgeEntityOutboxState(storage);
    return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/status") {
    const listed = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
    const jobs = [...listed.values()];
    if (jobs.length === 0) {
      return Response.json({ status: "empty" });
    }
    return Response.json({ jobs });
  }
  if (request.method !== "POST" || url.pathname !== "/ensure") {
    return new Response("not found", { status: 404 });
  }
  const input = parseEnsureRequest(await request.json());
  const result = await ensureHoldoverWriteJob(storage, putPort, input, nowMs, logger, suppression);
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

export function appSuppressionFromKv(kv: AssignmentKv): HoldoverWriteSuppressionPort {
  return {
    async isAppSuppressed(appId) {
      return (await kv.get(appHoldoverWriteSuppressKey(appId))) !== null;
    },
  };
}
