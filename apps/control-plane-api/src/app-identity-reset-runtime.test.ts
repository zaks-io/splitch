import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productionAppIdentityResetPurgers } from "./app-identity-reset-runtime";
import type { ControlPlaneApiEnv } from "./env";

describe("App identity reset privacy ledger redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts only Entity subject hashes and preserves App request evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const db = (env as typeof env & { DB: D1Database }).DB;
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES ('org_1', 'Org', 'org-1', 'free', ?, ?)",
          )
          .bind("2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z"),
        app(db, "app_a", "app-a"),
        app(db, "app_b", "app-b"),
        privacyRequest(db, "entity-a", "app_a", "entity", '["app-v1:old"]'),
        privacyRequest(db, "app-a", "app_a", "app", "app_a"),
        privacyRequest(db, "entity-b", "app_b", "entity", '["app-v1:other"]'),
        privacyRequest(db, "entity-redacted", "app_a", "entity", "redacted:app-identity-reset"),
        db
          .prepare(
            "INSERT INTO privacy_jobs (job_id, request_id, kind, status, store_status_json, identity_version, id_type, entity_family_hash, artifact_key, artifact_sha256, artifact_expires_at, created_at, updated_at) VALUES ('job-entity-a', 'entity-a', 'export', 'completed', '{}', 'app-v1', 'user', 'app-v1:old', 'privacy-exports/app_a/entity-a/attempt.json', 'sha256:old', '2026-08-29T00:00:00.000Z', ?, ?)",
          )
          .bind("2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z"),
      ]);
      const bucket = (env as typeof env & { PRIVACY_EXPORTS: R2Bucket }).PRIVACY_EXPORTS;
      await bucket.put("privacy-exports/app_a/entity-a/attempt.json", "private export");
      const purgers = productionAppIdentityResetPurgers(
        { DB: db, PRIVACY_EXPORTS: bucket } as ControlPlaneApiEnv,
        "reset_1",
      );

      await expect(purgers.privacy_subject_refs({ appId: "app_a" })).resolves.toBe(
        "d1-privacy-subject-refs:2;jobs=1;artifacts=1",
      );
      expect(await bucket.get("privacy-exports/app_a/entity-a/attempt.json")).toBeNull();
      expect(
        await db
          .prepare(
            "SELECT entity_family_hash, artifact_key, artifact_sha256 FROM privacy_jobs WHERE job_id = 'job-entity-a'",
          )
          .first(),
      ).toEqual({ entity_family_hash: null, artifact_key: null, artifact_sha256: null });
      const rows = await db
        .prepare(
          "SELECT request_id, subject_ref, subject_ref_redacted_at, result_json FROM privacy_requests ORDER BY request_id",
        )
        .all<{
          request_id: string;
          subject_ref: string;
          subject_ref_redacted_at: string | null;
          result_json: string | null;
        }>();
      expect(rows.results).toEqual([
        {
          request_id: "app-a",
          subject_ref: "app_a",
          subject_ref_redacted_at: null,
          result_json: '{"artifact":"app-evidence"}',
        },
        {
          request_id: "entity-a",
          subject_ref: "redacted:app-identity-reset",
          subject_ref_redacted_at: "2026-08-28T12:00:00.000Z",
          result_json: null,
        },
        {
          request_id: "entity-b",
          subject_ref: '["app-v1:other"]',
          subject_ref_redacted_at: null,
          result_json: '{"artifact":"app-evidence"}',
        },
        {
          request_id: "entity-redacted",
          subject_ref: "redacted:app-identity-reset",
          subject_ref_redacted_at: "2026-08-28T12:00:00.000Z",
          result_json: null,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App identity reset analytics generation inventory", () => {
  it("passes every frozen destroyed version unchanged to Analysis", async () => {
    const purgeAppIdentityAnalytics = vi.fn(async () => "analysis-proof");
    const purgers = productionAppIdentityResetPurgers(
      { ANALYSIS_API: { purgeAppIdentityAnalytics } } as unknown as ControlPlaneApiEnv,
      "reset_1",
    );

    await expect(
      purgers.analytics({
        appId: "app_a",
        currentVersion: "app-v1",
        destroyedVersions: ["local-v1", "v1", "app-v1"],
      }),
    ).resolves.toBe("analysis-proof");
    expect(purgeAppIdentityAnalytics).toHaveBeenCalledWith(
      "app_a",
      ["local-v1", "v1", "app-v1"],
      "reset_1",
    );
  });
});

function app(db: D1Database, appId: string, key: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, 'org_1', ?, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')",
    )
    .bind(appId, appId, key);
}

function privacyRequest(
  db: D1Database,
  requestId: string,
  appId: string,
  subjectType: "app" | "entity",
  subjectRef: string,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at, result_json) VALUES (?, 'org_1', ?, 'delete', ?, ?, 'user_1', 'processing', '2026-08-28T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '{\"artifact\":\"app-evidence\"}')",
    )
    .bind(requestId, appId, subjectType, subjectRef);
}
