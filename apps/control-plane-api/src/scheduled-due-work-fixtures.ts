import type { ScheduledDueWork } from "@splitch/db";
import { resetOrganizationGraph, seedEnvironment, seedOrgApp } from "./test-seeds";

export const NOW = "2026-10-22T08:00:00.000Z";
export const OLD = "2026-10-20T08:00:00.000Z";
const FUTURE = "2026-10-22T08:01:00.000Z";
const CUTOFF = "2026-10-21T08:00:00.000Z";

export async function resetDueWork(d1: D1Database) {
  await d1.batch(
    [
      "config_webhook_deliveries",
      "cloudflare_config_deliveries",
      "convex_installations",
      "cloudflare_installations",
      "sentry_installations",
      "control_plane_audit_events",
      "flag_change_events",
    ].map((table) => d1.prepare(`DELETE FROM ${table}`)),
  );
  await resetOrganizationGraph(d1);
  await seedOrgApp(d1, {
    orgId: "org_probe",
    orgName: "Probe",
    appId: "app_probe",
    appName: "Probe",
    appKey: "probe",
  });
  await seedEnvironment(d1, { appId: "app_probe", environmentId: "env_probe", key: "dev" });
}

export async function insertProbeRow(
  d1: D1Database,
  table: string,
  row: Record<string, string | number | null>,
) {
  const columns = Object.keys(row);
  await d1
    .prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(row))
    .run();
}

async function privacy(
  d1: D1Database,
  status: string,
  updatedAt: string,
  lease: string | null = null,
  artifact: string | null = null,
) {
  await insertProbeRow(d1, "privacy_requests", {
    request_id: "request_probe",
    org_id: "org_probe",
    app_id: "app_probe",
    request_type: "export",
    subject_type: "entity",
    subject_ref: "hash",
    requested_by: "user_probe",
    status,
    received_at: OLD,
    ack_due_at: OLD,
    response_due_at: OLD,
  });
  await insertProbeRow(d1, "privacy_jobs", {
    job_id: "job_probe",
    request_id: "request_probe",
    kind: "export",
    status,
    store_status_json: "{}",
    identity_version: "v1",
    created_at: OLD,
    updated_at: updatedAt,
    lease_expires_at: lease,
    artifact_key: artifact ? "artifact" : null,
    artifact_expires_at: artifact,
  });
}

export async function rotation(
  d1: D1Database,
  phase: string,
  updatedAt: string,
  stepUpJti: string | null = null,
) {
  await insertProbeRow(d1, "personal_access_tokens", {
    id: "token_probe",
    user_id: "user_probe",
    name: "Probe",
    token_hash: "synthetic_hash",
    grants: "[]",
    created_at: OLD,
  });
  await insertProbeRow(d1, "personal_access_token_rotations", {
    id: "rotation_probe",
    user_id: "user_probe",
    token_id: "token_probe",
    previous_hash: "old_hash",
    candidate_hash: "new_hash",
    operation_hash: "operation_hash",
    step_up_jti: stepUpJti,
    phase,
    claimed_at: OLD,
    updated_at: updatedAt,
  });
}

export async function delivery(
  d1: D1Database,
  provider: "convex" | "cloudflare",
  due: boolean,
  leased = false,
) {
  await insertProbeRow(d1, `${provider}_installations`, {
    installation_id: "installation_probe",
    app_id: "app_probe",
    environment_id: "env_probe",
    [provider === "convex" ? "callback_url" : "endpoint"]: "https://receiver.example/config",
    secret_ciphertext: "synthetic_cipher",
    secret_key_version: "v1",
    secret_fingerprint: "fingerprint",
    status: "active",
    created_at: OLD,
    updated_at: OLD,
  });
  await insertProbeRow(
    d1,
    provider === "convex" ? "config_webhook_deliveries" : "cloudflare_config_deliveries",
    {
      delivery_id: "delivery_probe",
      installation_id: "installation_probe",
      app_id: "app_probe",
      environment_id: "env_probe",
      environment_version: 1,
      state: leased ? "leased" : "pending",
      next_attempt_at: due ? NOW : FUTURE,
      created_at: OLD,
      lease_owner: leased ? "other" : null,
      lease_expires_at: leased ? (due ? NOW : FUTURE) : null,
      ...(provider === "convex" ? { body_json: "{}" } : {}),
    },
  );
}

export async function sentry(d1: D1Database, due: boolean) {
  await insertProbeRow(d1, "sentry_installations", {
    installation_id: "sentry_probe",
    org_id: "org_probe",
    webhook_url: "https://sentry.io/hook",
    secret_ciphertext: "synthetic_cipher",
    secret_key_version: "v1",
    secret_fingerprint: "fingerprint",
    status: "active",
    next_attempt_at: due ? NOW : FUTURE,
    created_at: OLD,
    updated_at: OLD,
  });
  await insertProbeRow(d1, "flag_change_events", {
    app_id: "app_probe",
    flag_id: "flag_probe",
    flag_key: "probe",
    action: "updated",
    target_type: "flag",
    changed_at: OLD,
  });
}

interface ProbeCase {
  name: string;
  job: keyof ScheduledDueWork;
  seed: (d1: D1Database, due: boolean) => Promise<unknown>;
}
export const PROBE_CASES: ProbeCase[] = [
  ...["queued", "failed"].map(
    (status): ProbeCase => ({
      name: `privacy ${status}`,
      job: "privacyReconciliation",
      seed: (d1, due) => privacy(d1, status, due ? "2026-10-22T07:59:00.000Z" : NOW),
    }),
  ),
  {
    name: "privacy expired lease",
    job: "privacyReconciliation",
    seed: (d1, due) => privacy(d1, "running", OLD, due ? NOW : FUTURE),
  },
  {
    name: "privacy artifact",
    job: "privacyArtifactPurge",
    seed: (d1, due) => privacy(d1, "completed", OLD, null, due ? NOW : FUTURE),
  },
  {
    name: "PAT rotation recovery",
    job: "personalAccessTokenRetention",
    seed: (d1, due) => rotation(d1, "claimed", due ? "2026-10-22T07:55:00.000Z" : NOW),
  },
  ...["completed", "retired"].map(
    (phase): ProbeCase => ({
      name: `PAT ${phase} rotation cleanup`,
      job: "personalAccessTokenRetention",
      seed: (d1, due) => rotation(d1, phase, due ? OLD : CUTOFF),
    }),
  ),
  {
    name: "PAT step-up cleanup",
    job: "personalAccessTokenRetention",
    seed: (d1, due) =>
      insertProbeRow(d1, "personal_access_token_step_up_uses", {
        jti: "use_probe",
        user_id: "user_probe",
        consumed_at: OLD,
        expires_at: due ? OLD : CUTOFF,
      }),
  },
  {
    name: "temporary Environment",
    job: "temporaryEnvironmentTeardown",
    seed: (d1, due) =>
      d1
        .prepare(
          "UPDATE environments SET expires_at = ?, synced_from_environment_id = 'source', synced_at = ? WHERE id = 'env_probe'",
        )
        .bind(due ? NOW : FUTURE, OLD)
        .run(),
  },
  {
    name: "audit forwarding",
    job: "auditEventForwarding",
    seed: (d1, due) =>
      insertProbeRow(d1, "control_plane_audit_events", {
        event_id: "audit_probe",
        app_id: "app_probe",
        organization_id: "org_probe",
        action: "updated",
        resource_type: "flag",
        resource_id: "flag_probe",
        outcome: "success",
        changes_json: "{}",
        changed_at: OLD,
        forwarded_at: due ? null : NOW,
      }),
  },
  ...(["convex", "cloudflare"] as const).flatMap((provider) =>
    [false, true].map(
      (leased): ProbeCase => ({
        name: `${provider} ${leased ? "lease" : "retry"}`,
        job: provider === "convex" ? "convexWebhookDispatch" : "cloudflarePushDispatch",
        seed: (d1, due) => delivery(d1, provider, due, leased),
      }),
    ),
  ),
  { name: "Sentry retry", job: "sentryWebhookDispatch", seed: sentry },
];
