import type { AssignmentKv } from "./assignment-store";
import { assignmentWriterName, type HashedAssignmentPutInput } from "./assignment-store";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import {
  appHoldoverWriteSuppressKey,
  type HoldoverWriteEnsureResult,
  type HoldoverWriteOutboxLogger,
  type HoldoverWritePutPort,
  type HoldoverWriteSuppressionPort,
  holdoverWriteOutboxName,
} from "./holdover-write-outbox-core";
import type { AssignmentWriterNamespace } from "./kv-assignment-store";

export type {
  HoldoverWriteEnsureResult,
  HoldoverWriteOutboxLogger,
  HoldoverWritePutPort,
  HoldoverWriteSuppressionPort,
} from "./holdover-write-outbox-core";

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
   * `accepted`). May resolve `poisoned` (fail-loud) or `suppressed` (deletion
   * cutoff — not holdover completion).
   */
  ensure(
    input: HashedAssignmentPutInput,
    options?: { sourceCreatedAtMs?: number },
  ): Promise<HoldoverWriteEnsureResult>;
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

/**
 * Durable Object-backed coordinator: seals retry ownership in DO storage, then
 * writes through Assignment Store Writer (putIfAbsent) until KV-complete.
 */
export class DurableHoldoverWriteCoordinator implements HoldoverWriteCoordinator {
  constructor(private readonly namespace: HoldoverWriteOutboxNamespace) {}

  async ensure(
    input: HashedAssignmentPutInput,
    options?: { sourceCreatedAtMs?: number },
  ): Promise<HoldoverWriteEnsureResult> {
    const name = holdoverWriteOutboxName(input);
    const stub = this.namespace.get(this.namespace.idFromName(name));
    let response: Response;
    try {
      response = await stub.fetch("https://holdover-write-outbox.local/ensure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          ...(options?.sourceCreatedAtMs !== undefined
            ? { sourceCreatedAtMs: options.sourceCreatedAtMs }
            : {}),
        }),
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

  async suppressEntity(input: HashedAssignmentPutInput, deleteBeforeTsMs: number): Promise<void> {
    await this.postDelete(input, deleteBeforeTsMs);
  }

  async purgeEntity(input: HashedAssignmentPutInput, deleteBeforeTsMs: number): Promise<void> {
    await this.postDelete(input, deleteBeforeTsMs);
  }

  private async postDelete(
    input: HashedAssignmentPutInput,
    deleteBeforeTsMs: number,
  ): Promise<void> {
    const name = holdoverWriteOutboxName(input);
    const stub = this.namespace.get(this.namespace.idFromName(name));
    const response = await stub.fetch("https://holdover-write-outbox.local/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteBeforeTsMs }),
    });
    if (!response.ok) {
      throw new HoldoverWriteOutboxError(
        `holdover write outbox /delete returned HTTP ${response.status}`,
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
  /** App-scoped Entity outbox inventory + deletion coordinator (SPL-346). */
  HOLDOVER_WRITE_APP_INVENTORY?: HoldoverWriteAppInventoryNamespace;
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
