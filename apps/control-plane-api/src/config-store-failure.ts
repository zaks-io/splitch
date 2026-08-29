import { DeletedFlagConfigSnapshotError } from "./config-store-snapshot-revision";
import type { ConfigStoreRuntimeDeps } from "./config-store-types";
import { SegmentNotFoundError } from "./targeting-rule-resolution";

export async function catchConfigStoreFailure<T>(
  deps: ConfigStoreRuntimeDeps,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof DeletedFlagConfigSnapshotError) {
      (deps.logger ?? console).error("config_store_deleted_snapshot_publication_refused", {
        flagId: cause.flagId,
        cause,
      });
      return { ok: false as const, reason: "FLAG_NOT_FOUND" as const };
    }
    if (cause instanceof SegmentNotFoundError) {
      return {
        ok: false as const,
        reason: "SEGMENT_NOT_FOUND" as const,
        missingSegmentIds: cause.missingSegmentIds,
      };
    }
    throw cause;
  }
}
