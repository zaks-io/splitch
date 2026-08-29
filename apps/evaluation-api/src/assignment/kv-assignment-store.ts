import { keyVersionOf, type SaltStore } from "@splitch/privacy";
import {
  type AssignmentIdentity,
  type AssignmentKv,
  type AssignmentPutInput,
  type AssignmentStore,
  type AssignmentStoreEntry,
  AssignmentStoreError,
  type AssignmentStoreLogger,
  type AssignmentStorePutResult,
  assignmentValueToMap,
  assignmentWriterName,
  hashedAssignmentIdentity,
  mergeRetainedAssignmentValues,
  readAssignmentValue,
  retainedAssignmentIdentities,
} from "./assignment-store";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";

export interface AssignmentWriterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): AssignmentWriterStub;
}

interface AssignmentWriterStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class KvAssignmentStore implements AssignmentStore {
  constructor(
    private readonly kv: AssignmentKv,
    private readonly writerNamespace: AssignmentWriterNamespace,
    private readonly saltStore: SaltStore,
    private readonly logger?: AssignmentStoreLogger,
    private readonly appInventory?: HoldoverWriteAppInventoryNamespace,
  ) {}

  async getAll(input: AssignmentIdentity): Promise<Map<string, AssignmentStoreEntry>> {
    const identities = await retainedAssignmentIdentities(this.saltStore, input);
    const values = [];
    for (const { entityKey } of identities) {
      values.push(await readAssignmentValue(this.kv, entityKey, this.logger));
    }
    return assignmentValueToMap(mergeRetainedAssignmentValues(values));
  }

  async put(input: AssignmentPutInput): Promise<AssignmentStorePutResult> {
    const existing = (await this.getAll(input)).get(input.experimentId);
    if (existing !== undefined) {
      return { status: "existing", assignment: existing };
    }
    const { targetingKeyHash } = await hashedAssignmentIdentity(this.saltStore, input);
    return this.putHashed({
      appId: input.appId,
      experimentId: input.experimentId,
      idType: input.idType,
      targetingKeyHash,
      identityVersion: input.identityVersion,
      runId: input.runId,
      variant: input.variant,
    });
  }

  async putHashed(
    input: Parameters<AssignmentStore["putHashed"]>[0],
  ): Promise<AssignmentStorePutResult> {
    if (this.appInventory) {
      if (input.identityVersion === undefined) {
        throw new AssignmentStoreError("Assignment identityVersion is required");
      }
      return new DurableHoldoverWriteAppInventoryClient(this.appInventory).putAssignment({
        ...input,
        identityVersion: input.identityVersion,
      });
    }
    const name = assignmentWriterName(input);
    const id = this.writerNamespace.idFromName(name);
    const stub = this.writerNamespace.get(id);

    const response = await stub.fetch("https://assignment-store.local/put", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: input.appId,
        experimentId: input.experimentId,
        idType: input.idType,
        targetingKeyHash: input.targetingKeyHash,
        identityVersion: input.identityVersion ?? keyVersionOf(input.targetingKeyHash),
        runId: input.runId,
        variant: input.variant,
      }),
    });

    if (!response.ok) {
      throw new AssignmentStoreError(`Assignment writer DO returned ${response.status}`);
    }

    return parsePutResult(await response.json());
  }
}

function parsePutResult(value: unknown): AssignmentStorePutResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    !("assignment" in value)
  ) {
    throw new AssignmentStoreError("Assignment writer DO returned a malformed response");
  }

  const { status, assignment } = value as {
    status: unknown;
    assignment: { runId?: unknown; variant?: unknown };
  };
  if (status !== "stored" && status !== "existing") {
    throw new AssignmentStoreError("Assignment writer DO returned an unknown status");
  }
  if (
    typeof assignment !== "object" ||
    assignment === null ||
    typeof assignment.runId !== "string" ||
    typeof assignment.variant !== "string"
  ) {
    throw new AssignmentStoreError("Assignment writer DO returned a malformed assignment");
  }

  return { status, assignment: { runId: assignment.runId, variant: assignment.variant } };
}
