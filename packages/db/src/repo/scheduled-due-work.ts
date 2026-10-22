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
    db.select({ due: sql`1` }).from(sql`privacy_jobs`).where(reconciliation).limit(1),
    db.select({ due: sql`1` }).from(sql`privacy_jobs`).where(artifacts).limit(1),
    db.select({ due: sql`1` }).from(sql`personal_access_token_rotations`).where(rotations).limit(1),
    db
      .select({ due: sql`1` })
      .from(sql`personal_access_token_rotations`)
      .where(expiredRotations)
      .limit(1),
    db
      .select({ due: sql`1` })
      .from(sql`personal_access_token_step_up_uses u`)
      .where(expiredUses)
      .limit(1),
    db
      .select({ due: sql`1` })
      .from(environments)
      .where(buildExpiredTemporaryEnvironmentsPredicate(now))
      .limit(1),
    db
      .select({ due: sql`1` })
      .from(controlPlaneAuditEvents)
      .where(buildPendingAuditEventsPredicate())
      .limit(1),
    db.select({ due: sql`1` }).from(sql`convex_installations installation ${convex}`).limit(1),
    db
      .select({ due: sql`1` })
      .from(sql`cloudflare_config_deliveries delivery ${cloudflare}`)
      .limit(1),
    db.select({ due: sql`1` }).from(sql`sentry_installations`).where(sentry).limit(1),
  ] as const;
  const results = await db.batch(statements);
  if (results.length !== statements.length)
    throw new Error("scheduled due-work probe: incomplete D1 batch");
  const due = (index: number) => {
    const result = results[index];
    if (!result) throw new Error("scheduled due-work probe: missing D1 result");
    return result.length > 0;
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
