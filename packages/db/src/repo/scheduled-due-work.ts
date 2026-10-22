import { sql } from "drizzle-orm";
import { controlPlaneAuditEvents } from "../schema/control-plane-audit-events";
import { environments } from "../schema/identity";
import { buildPendingAuditEventsPredicate } from "./audit-events";
import type { Db } from "./client";
import {
  buildDueCloudflareDeliveriesQuery,
  buildDueConvexDeliveriesQuery,
  buildDueSentryInstallationsPredicate,
  buildExpiredPersonalAccessTokenRotationsPredicate,
  buildExpiredPersonalAccessTokenStepUpUsesPredicate,
  buildExpiredPrivacyArtifactsPredicate,
  buildPendingPersonalAccessTokenRotationsPredicate,
  buildPrivacyJobsReconciliationPredicate,
  personalAccessTokenRetentionCutoff,
} from "./scheduled-due-predicates";
import { buildExpiredTemporaryEnvironmentsPredicate } from "./temporary-environments";

export interface ScheduledDueWork {
  privacyReconciliation: boolean;
  privacyArtifactPurge: boolean;
  personalAccessTokenRetention: boolean;
  temporaryEnvironmentTeardown: boolean;
  auditEventForwarding: boolean;
  convexWebhookDispatch: boolean;
  cloudflarePushDispatch: boolean;
  sentryWebhookDispatch: boolean;
}

export interface ScheduledDueWorkInput {
  now: string;
  privacyUpdatedBefore: string;
  rotationUpdatedBefore: string;
}

/** System sweep returning only booleans; job reads and claims retain their existing scopes. */
export async function probeScheduledDueWork(
  db: Db,
  d1: D1Database,
  input: ScheduledDueWorkInput,
): Promise<ScheduledDueWork> {
  const { now } = input;
  const cutoff = personalAccessTokenRetentionCutoff(now);
  const reconciliation = buildPrivacyJobsReconciliationPredicate({
    now,
    updatedBefore: input.privacyUpdatedBefore,
  });
  const artifacts = buildExpiredPrivacyArtifactsPredicate(now);
  const rotations = buildPendingPersonalAccessTokenRotationsPredicate(input.rotationUpdatedBefore);
  const expiredRotations = buildExpiredPersonalAccessTokenRotationsPredicate(cutoff);
  const expiredUses = buildExpiredPersonalAccessTokenStepUpUsesPredicate(cutoff);
  const convex = buildDueConvexDeliveriesQuery(now);
  const cloudflare = buildDueCloudflareDeliveriesQuery(now);
  const sentry = buildDueSentryInstallationsPredicate(now);
  const statements = [
    {
      sql: `SELECT 1 FROM privacy_jobs WHERE ${reconciliation.sql} LIMIT 1`,
      params: reconciliation.params,
    },
    { sql: `SELECT 1 FROM privacy_jobs WHERE ${artifacts.sql} LIMIT 1`, params: artifacts.params },
    {
      sql: `SELECT 1 FROM personal_access_token_rotations WHERE ${rotations.sql} LIMIT 1`,
      params: rotations.params,
    },
    {
      sql: `SELECT 1 FROM personal_access_token_rotations WHERE ${expiredRotations.sql} LIMIT 1`,
      params: expiredRotations.params,
    },
    {
      sql: `SELECT 1 FROM personal_access_token_step_up_uses u WHERE ${expiredUses.sql} LIMIT 1`,
      params: expiredUses.params,
    },
    db
      .select({ due: sql`1` })
      .from(environments)
      .where(buildExpiredTemporaryEnvironmentsPredicate(now))
      .limit(1)
      .toSQL(),
    db
      .select({ due: sql`1` })
      .from(controlPlaneAuditEvents)
      .where(buildPendingAuditEventsPredicate())
      .limit(1)
      .toSQL(),
    { sql: `SELECT 1 ${convex.sql} LIMIT 1`, params: convex.params },
    { sql: `SELECT 1 ${cloudflare.sql} LIMIT 1`, params: cloudflare.params },
    {
      sql: `SELECT 1 FROM sentry_installations WHERE ${sentry.sql} LIMIT 1`,
      params: sentry.params,
    },
  ];
  const results = await d1.batch(
    statements.map((query) => d1.prepare(query.sql).bind(...query.params)),
  );
  if (results.length !== statements.length || results.some((result) => !result.success))
    throw new Error("scheduled due-work probe: incomplete D1 batch");
  const due = (index: number) => {
    const result = results[index];
    if (!result) throw new Error("scheduled due-work probe: missing D1 result");
    return result.results.length > 0;
  };
  return {
    privacyReconciliation: due(0),
    privacyArtifactPurge: due(1),
    personalAccessTokenRetention: due(2) || due(3) || due(4),
    temporaryEnvironmentTeardown: due(5),
    auditEventForwarding: due(6),
    convexWebhookDispatch: due(7),
    cloudflarePushDispatch: due(8),
    sentryWebhookDispatch: due(9),
  };
}
