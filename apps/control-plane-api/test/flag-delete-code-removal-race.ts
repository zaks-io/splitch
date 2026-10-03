import { createRepository } from "@splitch/db";

export const LOSER_CLAIM = {
  state: "claimed" as const,
  reference: "https://example.com/pr/loser-must-not-land",
};

/** Run a competing write immediately before the first D1 `batch`. */
export function d1WithWriteBeforeFirstBatch(d1: D1Database, competing: () => Promise<unknown>) {
  let fired = false;
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (statements: unknown[]) => {
        if (!fired) {
          fired = true;
          await competing();
        }
        return (target as D1Database).batch(statements as never);
      };
    },
  }) as D1Database;
}

/** Older-worker delete: Flag gone, deletion audit row with NULL `diff_json`. */
export async function legacyDeleteLeavingNullAudit(
  d1: D1Database,
  appId: string,
  flagId: string,
  flagKey: string,
): Promise<{ seq: number }> {
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM runs WHERE app_id = ? AND experiment_id IN (
           SELECT id FROM experiments WHERE app_id = ? AND flag_id = ?
         )`,
      )
      .bind(appId, appId, flagId),
    d1.prepare("DELETE FROM experiments WHERE app_id = ? AND flag_id = ?").bind(appId, flagId),
    d1.prepare("DELETE FROM targeting_rules WHERE app_id = ? AND flag_id = ?").bind(appId, flagId),
    d1.prepare("DELETE FROM flag_configs WHERE app_id = ? AND flag_id = ?").bind(appId, flagId),
    d1.prepare("DELETE FROM variants WHERE flag_id = ?").bind(flagId),
    d1.prepare("DELETE FROM flags WHERE app_id = ? AND id = ?").bind(appId, flagId),
  ]);
  const row = await d1
    .prepare(
      `SELECT seq, diff_json AS diffJson FROM flag_change_events
       WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'
       ORDER BY seq DESC LIMIT 1`,
    )
    .bind(appId, flagId)
    .first<{ seq: number; diffJson: string | null }>();
  if (!row) {
    await d1
      .prepare(
        `INSERT INTO flag_change_events (
           app_id, environment_id, flag_id, flag_key, action, target_type,
           actor_ref, actor_via, changed_at, diff_json
         ) VALUES (?, NULL, ?, ?, 'deleted', 'flag', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)`,
      )
      .bind(appId, flagId, flagKey)
      .run();
  } else if (row.diffJson !== null) {
    await d1
      .prepare("UPDATE flag_change_events SET diff_json = NULL WHERE seq = ?")
      .bind(row.seq)
      .run();
  }
  const legacy = await d1
    .prepare(
      `SELECT seq FROM flag_change_events
       WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'
         AND diff_json IS NULL
       ORDER BY seq DESC LIMIT 1`,
    )
    .bind(appId, flagId)
    .first<{ seq: number }>();
  if (!legacy) throw new Error("legacy NULL deletion audit row was not seeded");
  return legacy;
}

export function racyRepository(d1: D1Database, competing: () => Promise<unknown>) {
  return createRepository(d1WithWriteBeforeFirstBatch(d1, competing));
}

export async function flagDeletionAuditRows(d1: D1Database, appId: string, flagId: string) {
  return d1
    .prepare(
      `SELECT seq, diff_json AS diffJson FROM flag_change_events
       WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'
       ORDER BY seq`,
    )
    .bind(appId, flagId)
    .all<{ seq: number; diffJson: string | null }>();
}
