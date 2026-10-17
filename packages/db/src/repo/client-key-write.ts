import { and, eq, isNull, sql } from "drizzle-orm";
import { clientKeys } from "../schema/index";
import { type AuditContext, auditInsert } from "./audit-event-write";
import type { Db } from "./client";
import { type EnvScope, withScope } from "./scope";
import { scopedTable } from "./scoped-table";

export function makeClientKeyWriteOps(db: Db) {
  const clientKeysTable = scopedTable(db, clientKeys);
  return {
    async updateClientKey(
      scope: EnvScope,
      keyId: string,
      values: Partial<typeof clientKeys.$inferInsert>,
      audit?: AuditContext,
      provision?: typeof clientKeys.$inferInsert,
    ) {
      assertProvision(keyId, provision, audit);
      if (!audit)
        return (
          (await clientKeysTable.update(scope, values, eq(clientKeys.keyId, keyId)))[0] ?? null
        );
      if ("appId" in values || "environmentId" in values)
        throw new Error("updateClientKey: cannot set scope columns");
      // A missing key is created with the requested settings in the audited batch.
      // A concurrent provisioner wins the unique active-Environment constraint;
      // returning no row lets the caller re-read and patch that winner.
      const query = clientKeyUpdateQuery(db, scope, keyId, values, provision);
      const [rows] = await db.batch([
        query,
        auditInsert(db, scope, {
          ...audit,
          action: "client_key_update",
          resourceType: "credential",
          resourceId: keyId,
          environmentId: scope.environmentId,
          metadata: {
            changedFields: Object.keys(values).filter(
              (field) => field === "originAllowlist" || field === "rateLimitRps",
            ),
          },
        }),
      ]);
      return rows[0] ?? null;
    },

    async rotateClientKey(
      scope: EnvScope,
      currentKeyId: string,
      values: typeof clientKeys.$inferInsert,
      audit: AuditContext,
      provision?: typeof clientKeys.$inferInsert,
    ) {
      assertProvision(currentKeyId, provision, audit);
      const statements = [
        db
          .update(clientKeys)
          .set({ revokedAt: audit.changedAt })
          .where(
            and(
              eq(clientKeys.appId, scope.appId),
              eq(clientKeys.environmentId, scope.environmentId),
              eq(clientKeys.keyId, currentKeyId),
              isNull(clientKeys.revokedAt),
            ),
          )
          .returning(),
        rotatedClientKeyInsert(db, scope, currentKeyId, values, audit),
        auditInsert(db, scope, {
          ...audit,
          action: "client_key_rotate",
          resourceType: "credential",
          resourceId: values.keyId,
          environmentId: scope.environmentId,
          metadata: { revokedKeyId: currentKeyId },
        }),
      ] as const;
      const [revoked, created] = provision
        ? await db
            .batch([
              db
                .insert(clientKeys)
                .values({ ...provision, appId: scope.appId, environmentId: scope.environmentId })
                .onConflictDoNothing(),
              ...statements,
            ])
            .then(([, ...results]) => results)
        : await db.batch(statements);
      return revoked[0] && created[0] ? { revoked: revoked[0], created: created[0] } : null;
    },
  };
}

function assertProvision(
  keyId: string,
  provision: typeof clientKeys.$inferInsert | undefined,
  audit: AuditContext | undefined,
) {
  if (!provision) return;
  if (!audit) throw new Error("Client Key provisioning requires an audit");
  if (provision.keyId !== keyId)
    throw new Error("Client Key provisioning requires a matching key id");
}

function clientKeyUpdateQuery(
  db: Db,
  scope: EnvScope,
  keyId: string,
  values: Partial<typeof clientKeys.$inferInsert>,
  provision: typeof clientKeys.$inferInsert | undefined,
) {
  return provision
    ? db
        .insert(clientKeys)
        .values({
          ...provision,
          ...values,
          appId: scope.appId,
          environmentId: scope.environmentId,
        })
        .onConflictDoNothing()
        .returning()
    : db
        .update(clientKeys)
        .set(values)
        .where(
          withScope(
            {
              appId: clientKeys.appId,
              appIdKey: "appId",
              environmentId: clientKeys.environmentId,
            },
            scope,
            eq(clientKeys.keyId, keyId),
          ),
        )
        .returning();
}

function rotatedClientKeyInsert(
  db: Db,
  scope: EnvScope,
  currentKeyId: string,
  values: typeof clientKeys.$inferInsert,
  audit: AuditContext,
) {
  return db
    .insert(clientKeys)
    .select(
      db
        .select({
          keyId: sql<string>`${values.keyId}`.as("key_id"),
          appId: clientKeys.appId,
          environmentId: clientKeys.environmentId,
          keyMaterial: sql<string>`${values.keyMaterial}`.as("key_material"),
          originAllowlist: sql<string | null>`${values.originAllowlist ?? null}`.as(
            "origin_allowlist",
          ),
          rateLimitRps: sql<number | null>`${values.rateLimitRps ?? null}`.as("rate_limit_rps"),
          revokedAt: sql<string | null>`NULL`.as("revoked_at"),
          createdAt: sql<string>`${values.createdAt ?? audit.changedAt}`.as("created_at"),
          createdBy: sql<string | null>`${values.createdBy ?? null}`.as("created_by"),
        })
        .from(clientKeys)
        .where(
          and(
            eq(clientKeys.appId, scope.appId),
            eq(clientKeys.environmentId, scope.environmentId),
            eq(clientKeys.keyId, currentKeyId),
            sql`changes() = 1`,
          ),
        ),
    )
    .returning();
}
