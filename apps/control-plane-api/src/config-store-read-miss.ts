import type { envScope, Repository } from "@splitch/db";
import type { ConfigStoreWriter } from "./config-store";
import { buildSnapshotFromD1, responseFromSnapshot } from "./config-store-shared";
import { SegmentNotFoundError } from "./targeting-rule-resolution";

type ReadInput = Parameters<ConfigStoreWriter["readFlagConfig"]>[0];
type RepairResult = Awaited<ReturnType<ConfigStoreWriter["repairFlagConfigSnapshot"]>>;

export async function readFlagConfigOnMiss(options: {
  input: ReadInput;
  key: string;
  logger: Pick<Console, "error" | "warn">;
  namespace: {
    getByName(name: string): Pick<ConfigStoreWriter, "repairFlagConfigSnapshot">;
  };
  remember: (result: RepairResult) => void;
  repo: Repository | undefined;
  scope: ReturnType<typeof envScope>;
  waitUntil: ((promise: Promise<unknown>) => void) | undefined;
}): ReturnType<ConfigStoreWriter["readFlagConfig"]> {
  const { input, key, logger, namespace, remember, repo, scope, waitUntil } = options;
  logger.warn("config_store_kv_snapshot_miss", { key, ...input });
  if (!repo || !waitUntil) {
    throw new Error("config-store: a KV miss requires a repository and waitUntil");
  }
  let snapshot: Awaited<ReturnType<typeof buildSnapshotFromD1>>;
  try {
    snapshot = await buildSnapshotFromD1(repo, scope, input.flagId);
  } catch (cause) {
    if (cause instanceof SegmentNotFoundError) {
      return {
        ok: false,
        reason: "SEGMENT_NOT_FOUND",
        missingSegmentIds: cause.missingSegmentIds,
      };
    }
    throw cause;
  }
  if (!snapshot) return { ok: false, reason: "FLAG_NOT_FOUND" };

  waitUntil(
    Promise.resolve()
      .then(() =>
        namespace
          .getByName(`${input.appId}:${input.environmentId}`)
          .repairFlagConfigSnapshot(input),
      )
      .then((result) => {
        if (!result.ok) {
          logger.error("config_store_kv_snapshot_repair_failed", { key, ...input, result });
          return;
        }
        remember(result);
      })
      .catch((cause: unknown) => {
        logger.error("config_store_kv_snapshot_repair_failed", { key, ...input, cause });
      }),
  );
  return { ok: true, config: responseFromSnapshot(snapshot) };
}
