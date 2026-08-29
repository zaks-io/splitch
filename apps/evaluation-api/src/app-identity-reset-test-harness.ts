import type {
  HoldoverWriteAppEntityRef,
  HoldoverWriteAppInventoryNamespace,
} from "./assignment/holdover-write-app-inventory";
import type { HoldoverWriteOutboxNamespace } from "./assignment/holdover-write-outbox";
import type { AssignmentWriterNamespace } from "./assignment/kv-assignment-store";
import type { EvaluationApiEnv } from "./env";

export const APP_ID = "app-A";
export const RESET_ID = "reset-1";
export const ENTITY_A = { idType: "user", targetingKeyHash: "v1:hash-a" } as const;
export const ENTITY_B = { idType: "device", targetingKeyHash: "v1:hash-b" } as const;
export const ENTITY_C = { idType: "account", targetingKeyHash: "v1:hash-c" } as const;

type SagaPhase = "prepared" | "canceling" | null;

interface CancelResponse {
  readonly cancelled: boolean;
  readonly done: boolean;
  readonly entities: readonly HoldoverWriteAppEntityRef[];
  readonly sagaPhase: SagaPhase;
}

export class ResetHarness {
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
          .map((name) => ({ name })),
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
    if (path === "/register") return this.registerEntity(init);
    if (path === "/begin-deletion") return this.beginDeletion(init);
    if (path === "/status") return Response.json(this.status());
    if (path === "/cancel-deletion" || path === "/complete-identity-reset") {
      return this.cancelFetch(path === "/complete-identity-reset");
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async registerEntity(init?: RequestInit): Promise<Response> {
    if (this.suppressed) return Response.json({ status: "suppressed" });
    const body = await requestBody(init);
    const ref = {
      idType: requireString(body, "idType"),
      targetingKeyHash: requireString(body, "targetingKeyHash"),
    };
    if (!this.entities.some((entity) => entityName(entity) === entityName(ref))) {
      this.entities.push(ref);
    }
    return Response.json({ status: "registered" });
  }

  private async beginDeletion(init?: RequestInit): Promise<Response> {
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
    return namespace(async (request, init) => {
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
      const body = await requestBody(init);
      this.kv.delete(
        `assignment:${requireString(body, "appId")}:${requireString(body, "idType")}:${requireString(body, "targetingKeyHash")}`,
      );
      this.tombstonedWriters.add(name);
      return Response.json({ deleted: true, proof: "assignment-do-cutoff-tombstone-v2" });
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
  return request.input instanceof Request ? request.input.url : String(request.input);
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

export function entityName(ref: HoldoverWriteAppEntityRef): string {
  return `${APP_ID}:${ref.idType}:${ref.targetingKeyHash}`;
}

function consumeFailure(failures: Map<string, number>, name: string): boolean {
  const remaining = failures.get(name) ?? 0;
  if (remaining <= 0) return false;
  failures.set(name, remaining - 1);
  return true;
}
