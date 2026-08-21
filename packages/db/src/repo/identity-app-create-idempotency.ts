import { and, eq } from "drizzle-orm";
import { apps } from "../schema/index";
import type { Db } from "./client";

export function makeAppCreateIdempotencyRepo(db: Db) {
  return {
    getAppCreateByIdempotency(orgId: string, actorId: string, idempotencyKey: string) {
      return db
        .select()
        .from(apps)
        .where(
          and(
            eq(apps.organizationId, orgId),
            eq(apps.createdBy, actorId),
            eq(apps.createIdempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    async completeAppCreate(appId: string, createResponse: string): Promise<void> {
      const rows = await db
        .update(apps)
        .set({ createResponse })
        .where(eq(apps.id, appId))
        .returning({ id: apps.id });
      if (rows.length !== 1) throw new Error("completeAppCreate: App was not updated");
    },
  };
}
