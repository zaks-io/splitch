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
      ]);
      const purgers = productionAppIdentityResetPurgers(
        { DB: db } as ControlPlaneApiEnv,
        "reset_1",
      );

      await expect(purgers.privacy_subject_refs({ appId: "app_a" })).resolves.toBe(
        "d1-privacy-subject-refs:1",
      );
      const rows = await db
        .prepare(
          "SELECT request_id, subject_ref, subject_ref_redacted_at FROM privacy_requests ORDER BY request_id",
        )
        .all<{
          request_id: string;
          subject_ref: string;
          subject_ref_redacted_at: string | null;
        }>();
      expect(rows.results).toEqual([
        { request_id: "app-a", subject_ref: "app_a", subject_ref_redacted_at: null },
        {
          request_id: "entity-a",
          subject_ref: "redacted:app-identity-reset",
          subject_ref_redacted_at: "2026-08-28T12:00:00.000Z",
        },
        {
          request_id: "entity-b",
          subject_ref: '["app-v1:other"]',
          subject_ref_redacted_at: null,
        },
        {
          request_id: "entity-redacted",
          subject_ref: "redacted:app-identity-reset",
          subject_ref_redacted_at: null,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
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
      "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at) VALUES (?, 'org_1', ?, 'delete', ?, ?, 'user_1', 'processing', '2026-08-28T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    )
    .bind(requestId, appId, subjectType, subjectRef);
}
