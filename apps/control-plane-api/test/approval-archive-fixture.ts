import { ids } from "../src/config-store-harness-core";

const HASH = `sha256:${"a".repeat(64)}`;

export interface ArchiveSeedOptions {
  id: string;
  appId?: string;
  status?: "pending" | "applied" | "declined" | "stale";
  proposedAt?: string;
  resolvedAt?: string | null;
  largeText?: string;
}

export async function seedApprovalArchiveFixture(
  d1: D1Database,
  options: ArchiveSeedOptions,
): Promise<void> {
  const appId = options.appId ?? ids.appId;
  const status = options.status ?? "declined";
  const proposedAt = options.proposedAt ?? "2026-04-01T00:00:00.000Z";
  const resolvedAt = fixtureResolvedAt(options.resolvedAt, status);
  const largeText = options.largeText ?? "complete-value";
  const diff = JSON.stringify({
    current: { description: largeText },
    proposed: { description: `${largeText}-changed` },
    entries: [
      {
        path: "/description",
        operation: "replace",
        current: largeText,
        proposed: `${largeText}-changed`,
      },
    ],
  });
  await d1
    .prepare(
      `INSERT INTO approval_requests (
        id, app_id, operation, target_type, target_id, target_version,
        policy_contexts, diff, status, proposed_by, proposed_via, proposed_at,
        resolved_at, resulting_target_version, resulting_resource_type,
        resulting_resource_id, idempotency_key, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      options.id,
      appId,
      "flag_config_update",
      "flag_configuration",
      ids.configId,
      HASH,
      JSON.stringify([
        {
          environmentId: ids.environmentId,
          changeTypes: ["targeting_rollout_value"],
          level: "confirm",
        },
      ]),
      diff,
      status,
      "user_archived",
      "id_jag",
      proposedAt,
      resolvedAt,
      status === "applied" ? HASH : null,
      status === "applied" ? "flag_configuration" : null,
      status === "applied" ? ids.configId : null,
      `idem_${options.id}`,
      HASH,
    )
    .run();
  if (status !== "pending") {
    if (!resolvedAt) throw new Error("terminal archive fixture requires resolvedAt");
    await seedReviews(d1, appId, options.id, resolvedAt, largeText, status);
  }
}

function fixtureResolvedAt(
  value: string | null | undefined,
  status: "pending" | "applied" | "declined" | "stale",
): string | null {
  if (value !== undefined) return value;
  return status === "pending" ? null : "2026-04-02T00:00:00.000Z";
}

async function seedReviews(
  d1: D1Database,
  appId: string,
  requestId: string,
  resolvedAt: string,
  largeText: string,
  status: "applied" | "declined" | "stale",
): Promise<void> {
  const failedAt = new Date(Date.parse(resolvedAt) - 1_000).toISOString();
  const reviewStem = `${requestId.slice(4, -2)}${requestId.at(-1)}`;
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO approval_reviews (
          id, app_id, approval_request_id, action, outcome, reviewed_by,
          reviewed_via, reviewed_at, reason, idempotency_key, request_hash,
          error_code, error_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `rev_${reviewStem}A`,
        appId,
        requestId,
        "approve_and_apply",
        "failed",
        "deleted-user:user_archived",
        "id_jag",
        failedAt,
        largeText,
        `idem_${requestId}_a`,
        HASH,
        "APPROVAL_APPLICATION_FAILED",
        JSON.stringify({ full: largeText }),
      ),
    d1
      .prepare(
        `INSERT INTO approval_reviews (
          id, app_id, approval_request_id, action, outcome, reviewed_by,
          reviewed_via, reviewed_at, reason, idempotency_key, request_hash,
          resulting_target_version, resulting_resource_type, resulting_resource_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `rev_${reviewStem}B`,
        appId,
        requestId,
        status === "declined" ? "decline" : "approve_and_apply",
        status,
        "deleted-user:user_archived",
        "device_flow",
        resolvedAt,
        largeText,
        `idem_${requestId}_b`,
        HASH,
        status === "applied" ? HASH : null,
        status === "applied" ? "flag_configuration" : null,
        status === "applied" ? ids.configId : null,
      ),
  ]);
}

export async function approvalRowCounts(
  d1: D1Database,
  requestId: string,
): Promise<{ requests: number; reviews: number; checkpoints: number }> {
  const [requests, reviews, checkpoints] = await d1.batch([
    d1.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE id = ?").bind(requestId),
    d1
      .prepare("SELECT COUNT(*) AS n FROM approval_reviews WHERE approval_request_id = ?")
      .bind(requestId),
    d1
      .prepare(
        "SELECT COUNT(*) AS n FROM approval_request_archive_checkpoints WHERE approval_request_id = ?",
      )
      .bind(requestId),
  ]);
  return {
    requests: Number((requests.results[0] as { n: number } | undefined)?.n ?? 0),
    reviews: Number((reviews.results[0] as { n: number } | undefined)?.n ?? 0),
    checkpoints: Number((checkpoints.results[0] as { n: number } | undefined)?.n ?? 0),
  };
}
