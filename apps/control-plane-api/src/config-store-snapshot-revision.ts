import type { ConfigStoreDeps, SnapshotRevisionRequest } from "./config-store-types";

type SnapshotRevisionStorage = Pick<DurableObjectStorage, "get" | "put">;

export class DeletedFlagConfigSnapshotError extends Error {
  constructor(readonly flagId: string) {
    super(`config-store: repair refused for deleted Flag Configuration ${flagId}`);
    this.name = "DeletedFlagConfigSnapshotError";
  }
}

export function makeDurableSnapshotRevisionAllocator(
  storage: SnapshotRevisionStorage,
): ConfigStoreDeps["nextSnapshotRevision"] {
  return async (request) => nextSnapshotRevision(storage, request);
}

async function nextSnapshotRevision(
  storage: SnapshotRevisionStorage,
  request: SnapshotRevisionRequest,
): Promise<number> {
  const stateKey = snapshotStateKey(request.flagId);
  const [current, state] = await Promise.all([
    storage.get<number>(SNAPSHOT_REVISION_KEY),
    storage.get<SnapshotState>(stateKey),
  ]);
  if (request.operation === "repair" && state === "deleted") {
    throw new DeletedFlagConfigSnapshotError(request.flagId);
  }

  const revision = current ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("config-store: invalid snapshot revision state");
  }
  const next = revision + 1;
  await storage.put({
    [SNAPSHOT_REVISION_KEY]: next,
    [stateKey]: request.operation === "delete" ? "deleted" : "present",
  });
  return next;
}

type SnapshotState = "present" | "deleted";

const SNAPSHOT_REVISION_KEY = "control-plane-snapshot-revision";

function snapshotStateKey(flagId: string): string {
  return `control-plane-snapshot-state:${flagId}`;
}
