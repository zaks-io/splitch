import { assignmentKey } from "@splitch/contracts";
import type { AssignmentStoreEntry } from "./assignment-store";
import {
  type AssignmentKv,
  type AssignmentStorePutResult,
  type HashedAssignmentPutInput,
  mergeAssignmentValue,
  readAssignmentValue,
  serializeAssignmentValue,
} from "./assignment-store";

const STORAGE_KEY = "assignment";

export interface AssignmentWriterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

interface StoredAssignment extends HashedAssignmentPutInput {}

export class AssignmentStoreWriter {
  constructor(
    private readonly storage: AssignmentWriterStorage,
    private readonly kv: AssignmentKv,
    private readonly waitUntil: WaitUntil,
  ) {}

  async put(input: HashedAssignmentPutInput): Promise<AssignmentStorePutResult> {
    const existing = await this.storage.get<StoredAssignment>(STORAGE_KEY);
    if (existing !== undefined) {
      return { status: "existing", assignment: entryFrom(existing) };
    }

    await this.storage.put(STORAGE_KEY, input);
    this.waitUntil(this.writeThrough(input));
    return { status: "stored", assignment: entryFrom(input) };
  }

  private async writeThrough(input: HashedAssignmentPutInput): Promise<void> {
    const key = assignmentKey(input.appId, input.idType, input.targetingKeyHash);
    const current = await readAssignmentValue(this.kv, key);
    const next = mergeAssignmentValue(current, input);
    await this.kv.put(key, serializeAssignmentValue(next));
  }
}

function entryFrom(input: Pick<StoredAssignment, "runId" | "variant">): AssignmentStoreEntry {
  return { runId: input.runId, variant: input.variant };
}
