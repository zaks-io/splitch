import { describe, expect, it } from "vitest";
import { createEntityPrivacyConsumer } from "./entity-privacy-consumer";

const HASH = "hash_app_epoch";
const FAMILY = "family_app";
const IDENTITY = {
  appId: "app_privacy",
  idType: "user",
  targetingKeyHashes: [HASH],
  entityFamilyHash: FAMILY,
};

function service(result: (path: string) => unknown): Fetcher {
  return {
    fetch: async (request: Request) => Response.json(result(new URL(request.url).pathname)),
  } as unknown as Fetcher;
}

describe("createEntityPrivacyConsumer export", () => {
  it("returns a durable artifact containing every store's records and proofs", async () => {
    const assignments = [
      {
        targetingKeyHash: HASH,
        assignments: { exp_checkout: { runId: "run_1", variant: "control" } },
        holdoverWrites: [{ environmentId: "env_prod", experimentId: "exp_checkout" }],
      },
    ];
    const analytics = [{ source: "metric_events", event_name: "purchased" }];
    const events = [{ store: "metric-event-outbox", deliveryId: "delivery_1" }];
    const consumer = createEntityPrivacyConsumer(
      service(() => ({
        ...IDENTITY,
        records: assignments,
        proofs: [`assignment-kv:${HASH}`],
      })),
      service(() => ({
        ...IDENTITY,
        records: analytics,
        proofs: [
          `tinybird:raw_events:${HASH}`,
          `tinybird:metric_events:${HASH}`,
          `tinybird:deduped_exposures:${HASH}`,
          `tinybird:deduped_metric_events_state:${HASH}`,
        ],
      })),
      service(() => ({
        ...IDENTITY,
        records: events,
        proofs: [
          `metric-event-outbox-inventory:${HASH}`,
          `evaluation-commit-outbox-inventory:${HASH}`,
        ],
      })),
    );

    const result = await consumer?.exportEntity({
      appId: IDENTITY.appId,
      idType: IDENTITY.idType,
      targetingKey: "raw-key-never-in-artifact",
      actorId: "user_admin",
      orgId: "org_privacy",
      requestId: "request_privacy",
    });

    expect(result?.exportArtifact).toEqual({
      schemaVersion: "entity-privacy-export-v1",
      ...IDENTITY,
      stores: [
        { name: "assignments", records: assignments, proofs: [`assignment-kv:${HASH}`] },
        {
          name: "analysis",
          records: analytics,
          proofs: [
            `tinybird:raw_events:${HASH}`,
            `tinybird:metric_events:${HASH}`,
            `tinybird:deduped_exposures:${HASH}`,
            `tinybird:deduped_metric_events_state:${HASH}`,
          ],
        },
        {
          name: "event-ingest",
          records: events,
          proofs: [
            `metric-event-outbox-inventory:${HASH}`,
            `evaluation-commit-outbox-inventory:${HASH}`,
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("raw-key-never-in-artifact");
  });
});
