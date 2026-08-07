import {
  assignmentKey,
  type AssignmentStoreEntry,
  type AssignmentStoreValue,
  AssignmentStoreValueSchema,
  CURRENT_KV_SCHEMA_VERSION,
  kvEnvelope,
} from "@splitch/contracts";
import { computeTargetingKeyHash, type SaltStore } from "@splitch/privacy";

export type { AssignmentStoreEntry } from "@splitch/contracts";

export interface AssignmentIdentity {
  appId: string;
  idType: string;
  targetingKey: string;
}

export interface AssignmentPutInput extends AssignmentIdentity {
  experimentId: string;
  runId: string;
  variant: string;
}

export interface HashedAssignmentPutInput {
  appId: string;
  experimentId: string;
  idType: string;
  targetingKeyHash: string;
  runId: string;
  variant: string;
}

export interface AssignmentStore {
  getAll(input: AssignmentIdentity): Promise<Map<string, AssignmentStoreEntry>>;
  put(input: AssignmentPutInput): Promise<AssignmentStorePutResult>;
  /**
   * Holdover write when only the Targeting Key hash is known (Exposure Ticket
   * redemption — the raw Targeting Key never rides in a ticket).
   */
  putHashed(input: HashedAssignmentPutInput): Promise<AssignmentStorePutResult>;
}

export interface AssignmentStorePutResult {
  status: "stored" | "existing";
  assignment: AssignmentStoreEntry;
}

export interface AssignmentKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface AssignmentStoreLogger {
  error(message: string, detail: unknown): void;
}

export class AssignmentStoreError extends Error {
  readonly errorCode = "INTERNAL_SERVER_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssignmentStoreError";
  }
}

type SafeParse<T> =
  | { success: true; data: { data: T } }
  | { success: false; error: { message: string } };

const parseAssignmentEnvelope = kvEnvelope(AssignmentStoreValueSchema) as {
  safeParse(json: unknown): SafeParse<AssignmentStoreValue>;
};

export async function hashedAssignmentIdentity(
  saltStore: SaltStore,
  input: AssignmentIdentity,
): Promise<{ entityKey: string; targetingKeyHash: string }> {
  const targetingKeyHash = await computeTargetingKeyHash(saltStore, input);
  return {
    entityKey: assignmentKey(input.appId, input.idType, targetingKeyHash),
    targetingKeyHash,
  };
}

export function assignmentWriterName(
  input: Pick<HashedAssignmentPutInput, "appId" | "idType" | "targetingKeyHash">,
): string {
  // One DO per ENTITY (not per entity+experiment): the entity-level KV blob is
  // read-merge-written by the writer, so every write for an entity must pass
  // through the same serialization point — per-experiment DOs racing on the
  // shared blob would clobber each other's first-touch entries.
  return `${input.appId}:${input.idType}:${input.targetingKeyHash}`;
}

export function assignmentValueToMap(
  value: AssignmentStoreValue,
): Map<string, AssignmentStoreEntry> {
  return new Map(Object.entries(value));
}

export function mergeAssignmentValue(
  value: AssignmentStoreValue,
  input: Pick<HashedAssignmentPutInput, "experimentId" | "runId" | "variant">,
): AssignmentStoreValue {
  if (value[input.experimentId] !== undefined) {
    return value;
  }
  return {
    ...value,
    [input.experimentId]: { runId: input.runId, variant: input.variant },
  };
}

export function serializeAssignmentValue(value: AssignmentStoreValue): string {
  return JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data: value });
}

function parseAssignmentValue(raw: string, key: string): AssignmentStoreValue {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new AssignmentStoreError(`Malformed assignment KV JSON for key "${key}"`, { cause });
  }

  const parsed = parseAssignmentEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new AssignmentStoreError(
      `Invalid assignment KV blob for key "${key}": ${parsed.error.message}`,
    );
  }
  return parsed.data.data;
}

export async function readAssignmentValue(
  kv: Pick<AssignmentKv, "get">,
  key: string,
  logger?: AssignmentStoreLogger,
): Promise<AssignmentStoreValue> {
  let raw: string | null;
  try {
    raw = await kv.get(key);
  } catch (cause) {
    // An infrastructure read failure must fail loud like a parse failure: if it
    // surfaced as a raw error, preloadHoldovers would swallow it as "no
    // holdovers" and silently re-assign an entity that holds an assignment.
    logger?.error("assignment_store_kv_read_failed", { key, cause });
    throw new AssignmentStoreError(`Assignment KV read failed for key "${key}"`, { cause });
  }
  if (raw === null) {
    return {};
  }

  try {
    return parseAssignmentValue(raw, key);
  } catch (cause) {
    logger?.error("assignment_store_kv_parse_failed", { key, cause });
    throw cause;
  }
}
