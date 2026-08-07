import type { SaltStore } from "@splitch/privacy";
import {
  type AssignmentIdentity,
  type AssignmentStoreEntry,
  assignmentValueToMap,
  assignmentWriterName,
  type AssignmentKv,
  type AssignmentPutInput,
  type AssignmentStore,
  AssignmentStoreError,
  type AssignmentStoreLogger,
  type AssignmentStorePutResult,
  hashedAssignmentIdentity,
  readAssignmentValue,
} from "./assignment-store";

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
  ) {}

  async getAll(input: AssignmentIdentity): Promise<Map<string, AssignmentStoreEntry>> {
    const { entityKey } = await hashedAssignmentIdentity(this.saltStore, input);
    return assignmentValueToMap(await readAssignmentValue(this.kv, entityKey, this.logger));
  }

  async put(input: AssignmentPutInput): Promise<AssignmentStorePutResult> {
    const { targetingKeyHash } = await hashedAssignmentIdentity(this.saltStore, input);
    return this.putHashed({
      appId: input.appId,
      experimentId: input.experimentId,
      idType: input.idType,
      targetingKeyHash,
      runId: input.runId,
      variant: input.variant,
    });
  }

  async putHashed(input: {
    appId: string;
    experimentId: string;
    idType: string;
    targetingKeyHash: string;
    runId: string;
    variant: string;
  }): Promise<AssignmentStorePutResult> {
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
