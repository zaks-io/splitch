import { sql } from "drizzle-orm";
import { controlPlaneAuditEvents } from "../schema/control-plane-audit-events";
import { environments } from "../schema/identity";
import { buildPendingAuditEventsPredicate } from "./audit-events";
import type { Db } from "./client";
import {
  buildIntegrationDeliveryLagQuery,
  type IntegrationDeliveryLag,
} from "./integration-delivery-lag";
import { buildDueDeliveryEnvironmentsQuery } from "./integration-delivery-schedule";
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
  minuteDeliveryMode?: "coordinator" | "cron";
}

export interface ScheduledDueWorkResult extends ScheduledDueWork {
  delivery?: {
    scopes?: Array<{ appId: string; environmentId: string }>;
    lag: Record<"convex" | "cloudflare", IntegrationDeliveryLag[]>;
  };
}

/** System sweep; job claims retain their existing scopes. */
export async function probeScheduledDueWork(
  db: Db,
  input: ScheduledDueWorkInput,
): Promise<ScheduledDueWorkResult> {
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
    db.select({ due: sql`1` }).from(sql`sentry_installations`).where(sentry).limit(1),
  ] as const;
  const dispatch = { convexWebhookDispatch: false, cloudflarePushDispatch: false };
  const legacyDispatch = () =>
    [
      db
        .select({ due: sql`1` })
        .from(sql`convex_installations installation ${buildDueConvexDeliveriesQuery(now)}`)
        .limit(1),
      db
        .select({ due: sql`1` })
        .from(sql`cloudflare_config_deliveries delivery ${buildDueCloudflareDeliveriesQuery(now)}`)
        .limit(1),
    ] as const;
  const lag = () =>
    [
      buildIntegrationDeliveryLagQuery(db, "convex", now),
      buildIntegrationDeliveryLagQuery(db, "cloudflare", now),
    ] as const;
  let results: Array<Array<unknown>>;
  let delivery: ScheduledDueWorkResult["delivery"];
  if (input.minuteDeliveryMode === "coordinator") {
    const rows = await db.batch([
      ...statements,
      buildDueDeliveryEnvironmentsQuery(db, { now }),
      ...lag(),
    ]);
    assertCompleteBatch(rows, 11);
    results = rows;
    delivery = { scopes: rows[8], lag: { convex: rows[9], cloudflare: rows[10] } };
  } else if (input.minuteDeliveryMode === "cron") {
    const rows = await db.batch([...statements, ...legacyDispatch(), ...lag()]);
    assertCompleteBatch(rows, 12);
    results = rows;
    dispatch.convexWebhookDispatch = rows[8].length > 0;
    dispatch.cloudflarePushDispatch = rows[9].length > 0;
    delivery = { lag: { convex: rows[10], cloudflare: rows[11] } };
  } else {
    const rows = await db.batch([...statements, ...legacyDispatch()]);
    assertCompleteBatch(rows, 10);
    results = rows;
    dispatch.convexWebhookDispatch = rows[8].length > 0;
    dispatch.cloudflarePushDispatch = rows[9].length > 0;
  }
  const due = (index: number) => {
    const result = results[index];
    if (!result) throw new Error("scheduled due-work probe: missing D1 result");
    return result.length > 0;
  };
  return {
    ...dispatch,
    ...(delivery ? { delivery } : {}),
    privacyReconciliation: due(0),
    privacyArtifactPurge: due(1),
    personalAccessTokenRetention: due(2) || due(3) || due(4),
    temporaryEnvironmentTeardown: due(5),
    auditEventForwarding: due(6),
    sentryWebhookDispatch: due(7),
  };
}

function assertCompleteBatch(rows: readonly unknown[], expected: number): void {
  if (rows.length !== expected) throw new Error("scheduled due-work probe: incomplete D1 batch");
}
