import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAppIdentityReset, purgeAppIdentityAssignments } from "./app-identity-reset";
import type {
  HoldoverWriteAppEntityRef,
  HoldoverWriteAppInventoryNamespace,
} from "./assignment/holdover-write-app-inventory";
import type { HoldoverWriteOutboxNamespace } from "./assignment/holdover-write-outbox";
import type { AssignmentWriterNamespace } from "./assignment/kv-assignment-store";
import type { EvaluationApiEnv } from "./env";

const APP_ID = "app-A";
const RESET_ID = "reset-1";
const ENTITY_A = { idType: "user", targetingKeyHash: "v1:hash-a" } as const;
const ENTITY_B = { idType: "device", targetingKeyHash: "v1:hash-b" } as const;

afterEach(() => vi.restoreAllMocks());

describe("App identity Assignment reset", () => {
  it("purges every Entity from durable status when begin returns no entities", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    const reset = new ResetHarness([ENTITY_A, ENTITY_B]);
    reset.kv.set(`assignment:${APP_ID}:user:${ENTITY_A.targetingKeyHash}`, "a");
    reset.kv.set(`assignment:${APP_ID}:device:${ENTITY_B.targetingKeyHash}`, "b");

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).resolves.toBe(
      "evaluation-assignments:kv=2;durable_inventory=empty;durable_objects=4",
    );

    expect(reset.entities).toEqual([]);
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_A)}`,
      `outbox:delete:${entityName(ENTITY_A)}:9000`,
      `writer:delete:${entityName(ENTITY_B)}`,
      `outbox:delete:${entityName(ENTITY_B)}:9000`,
    ]);
  });

  it("retains the durable Entity checkpoint when writer deletion fails, then resumes after restart", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(9_000).mockReturnValueOnce(12_000);
    const reset = new ResetHarness([ENTITY_A, ENTITY_B]);
    reset.writerDeleteFailures.set(entityName(ENTITY_B), 1);

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).rejects.toThrow(
      /Assignment writer purge returned HTTP 503/u,
    );
    expect(reset.entities).toEqual([ENTITY_B]);
    expect(reset.calls).not.toContain(`outbox:delete:${entityName(ENTITY_B)}:9000`);

    reset.calls.length = 0;
    const restartedEnv = reset.env();
    await expect(purgeAppIdentityAssignments(restartedEnv, APP_ID, RESET_ID)).resolves.toContain(
      "durable_inventory=empty",
    );
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_B)}`,
      `outbox:delete:${entityName(ENTITY_B)}:9000`,
    ]);
  });

  it("tombstones the writer before an outbox failure and prevents old-hash resurrection on retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    const reset = new ResetHarness([ENTITY_A]);
    reset.outboxDeleteFailures.set(entityName(ENTITY_A), 1);

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).rejects.toThrow(
      /outbox purge returned HTTP 503/u,
    );
    expect(reset.entities).toEqual([ENTITY_A]);
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_A)}`,
      `outbox:delete:${entityName(ENTITY_A)}:9000`,
    ]);
    await expect(reset.putOldAssignment(ENTITY_A)).resolves.toMatchObject({ status: 409 });

    reset.calls.length = 0;
    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).resolves.toContain(
      "durable_inventory=empty",
    );
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_A)}`,
      `outbox:delete:${entityName(ENTITY_A)}:9000`,
    ]);
  });

  it("keeps reset completion blocked until the durable cancellation reports done", async () => {
    const reset = new ResetHarness([]);
    reset.freeze();
    reset.cancelResponses.push(
      {
        cancelled: true,
        done: false,
        entities: [ENTITY_B],
        sagaPhase: "canceling",
      },
      { cancelled: true, done: true, entities: [], sagaPhase: null },
    );

    await expect(completeAppIdentityReset(reset.env(), APP_ID, RESET_ID)).rejects.toThrow(
      /cancellation is incomplete.*1 Entity checkpoint/u,
    );
    expect(reset.directKvDeletes).toBe(0);
    expect(reset.suppressed).toBe(true);

    await expect(completeAppIdentityReset(reset.env(), APP_ID, RESET_ID)).resolves.toBeUndefined();
    expect(reset.directKvDeletes).toBe(0);
    expect(reset.suppressed).toBe(false);
    expect(reset.phase).toBeNull();
    await expect(completeAppIdentityReset(reset.env(), APP_ID, RESET_ID)).resolves.toBeUndefined();
    expect(reset.completedResetId).toBe(RESET_ID);
  });
});

type SagaPhase = "prepared" | "canceling" | null;

interface CancelResponse {
  readonly cancelled: boolean;
  readonly done: boolean;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
  readonly sagaPhase: SagaPhase;
}

class ResetHarness {
  readonly calls: string[] = [];
  readonly kv = new Map<string, string>();
  readonly tombstonedWriters = new Set<string>();
  readonly writerDeleteFailures = new Map<string, number>();
  readonly outboxDeleteFailures = new Map<string, number>();
  readonly cancelResponses: CancelResponse[] = [];
  entities: HoldoverWriteAppEntityRef[];
  generationId: string | null = null;
  suppressed = false;
  phase: SagaPhase = null;
  cutoff: number | null = null;
  directKvDeletes = 0;
  completedResetId: string | null = null;

  constructor(entities: readonly HoldoverWriteAppEntityRef[]) {
    this.entities = [...entities];
  }

  freeze(): void {
    this.generationId = RESET_ID;
    this.suppressed = true;
    this.phase = "prepared";
    this.cutoff = 9_000;
    this.kv.set(`holdover-write:suppress:${APP_ID}`, "1");
  }

  env(): EvaluationApiEnv {
    return {
      ASSIGNMENTS_KV: this.assignmentKv(),
      ASSIGNMENT_STORE_WRITER: this.writerNamespace(),
      HOLDOVER_WRITE_OUTBOX: this.outboxNamespace(),
      HOLDOVER_WRITE_APP_INVENTORY: this.inventoryNamespace(),
    } as unknown as EvaluationApiEnv;
  }

  putOldAssignment(ref: HoldoverWriteAppEntityRef): Promise<Response> {
    const namespace = this.writerNamespace();
    return namespace
      .get(namespace.idFromName(entityName(ref)))
      .fetch("https://assignment-store.local/put", { method: "POST" });
  }

  private assignmentKv(): KVNamespace {
    return {
      get: async (key: string) => this.kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        this.kv.set(key, value);
      },
      delete: async (key: string) => {
        this.directKvDeletes += 1;
        this.kv.delete(key);
      },
      list: async ({ prefix }: { prefix?: string }) => ({
        keys: [...this.kv.keys()]
          .filter((key) => key.startsWith(prefix ?? ""))
          .map((name) => ({
            name,
          })),
        list_complete: true,
        cacheStatus: null,
      }),
    } as unknown as KVNamespace;
  }

  private inventoryNamespace(): HoldoverWriteAppInventoryNamespace {
    return namespace((request, init) => this.inventoryFetch(request, init));
  }

  private async inventoryFetch(input: NamedRequest, init?: RequestInit): Promise<Response> {
    const path = new URL(requestUrl(input)).pathname;
    if (path === "/begin-deletion") {
      this.completedResetId = null;
      const body = await requestBody(init);
      const generationId = requireString(body, "generationId");
      if (this.phase === null) {
        this.generationId = generationId;
        this.suppressed = true;
        this.phase = "prepared";
        this.cutoff = requireNumber(body, "deleteBeforeTsMs");
      }
      return Response.json({
        suppressed: true,
        generationId: this.generationId,
        deletionComplete: false,
        deleteBeforeTsMs: requireNumber(body, "deleteBeforeTsMs"),
        entities: [],
        sagaPhase: this.phase,
      });
    }
    if (path === "/status") return Response.json(this.status());
    if (path === "/cancel-deletion" || path === "/complete-identity-reset") {
      return this.cancelFetch(path === "/complete-identity-reset");
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private cancelFetch(completingReset: boolean): Response {
    if (completingReset && this.completedResetId === RESET_ID) {
      return Response.json({ cancelled: true, done: true, entities: [], sagaPhase: null });
    }
    const response = this.cancelResponses.shift() ?? {
      cancelled: true,
      done: true,
      entities: [],
      sagaPhase: null,
    };
    if (!response.done) {
      this.phase = "canceling";
      return Response.json(response);
    }
    if (completingReset) this.completedResetId = RESET_ID;
    this.generationId = null;
    this.suppressed = false;
    this.phase = null;
    this.cutoff = null;
    this.kv.delete(`holdover-write:suppress:${APP_ID}`);
    return Response.json(response);
  }

  private status() {
    return {
      generationId: this.generationId,
      suppressed: this.suppressed,
      deletionComplete: false,
      deleteBeforeTsMs: this.cutoff,
      entities: this.entities,
      sagaPhase: this.phase,
    };
  }

  private writerNamespace(): AssignmentWriterNamespace {
    return namespace(async (request) => {
      const name = request.name;
      const path = new URL(requestUrl(request)).pathname;
      if (path === "/put") {
        return this.tombstonedWriters.has(name)
          ? Response.json({ error: "Entity assignments are deleted" }, { status: 409 })
          : Response.json({ status: "stored" });
      }
      this.calls.push(`writer:delete:${name}`);
      if (consumeFailure(this.writerDeleteFailures, name)) {
        return Response.json({ error: "forced writer failure" }, { status: 503 });
      }
      this.tombstonedWriters.add(name);
      return Response.json({ deleted: true, proof: "assignment-do-tombstone-v1" });
    });
  }

  private outboxNamespace(): HoldoverWriteOutboxNamespace {
    return namespace(async (request, init) => {
      const name = request.name;
      const body = await requestBody(init);
      this.calls.push(`outbox:delete:${name}:${String(requireNumber(body, "deleteBeforeTsMs"))}`);
      if (!this.tombstonedWriters.has(name)) {
        return Response.json({ error: "writer is not tombstoned" }, { status: 409 });
      }
      if (consumeFailure(this.outboxDeleteFailures, name)) {
        return Response.json({ error: "forced outbox failure" }, { status: 503 });
      }
      this.entities = this.entities.filter((ref) => entityName(ref) !== name);
      return Response.json({ ok: true, remainingJobs: false });
    });
  }
}

function namespace<T>(fetch: (request: NamedRequest, init?: RequestInit) => Promise<Response>): T {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch({ input, name: String(id) }, init),
    }),
  } as T;
}

interface NamedRequest {
  readonly input: RequestInfo | URL;
  readonly name: string;
}

function requestUrl(request: NamedRequest): string {
  const input = request.input;
  return input instanceof Request ? input.url : String(input);
}

async function requestBody(init?: RequestInit): Promise<Record<string, unknown>> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new TypeError(`${key} must be a string`);
  return field;
}

function requireNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number") throw new TypeError(`${key} must be a number`);
  return field;
}

function entityName(ref: HoldoverWriteAppEntityRef): string {
  return `${APP_ID}:${ref.idType}:${ref.targetingKeyHash}`;
}

function consumeFailure(failures: Map<string, number>, name: string): boolean {
  const remaining = failures.get(name) ?? 0;
  if (remaining <= 0) return false;
  failures.set(name, remaining - 1);
  return true;
}
