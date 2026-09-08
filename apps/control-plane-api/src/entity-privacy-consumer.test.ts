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

function service(result: (path: string, body: Record<string, unknown>) => unknown): Fetcher {
  return {
    fetch: async (request: Request) =>
      Response.json(
        result(new URL(request.url).pathname, (await request.json()) as Record<string, unknown>),
      ),
  } as unknown as Fetcher;
}

describe("createEntityPrivacyConsumer export", () => {
  it("resolves identity once and exposes bounded Analysis and Event Ingest page calls", async () => {
    const assignments = [
      {
        targetingKeyHash: HASH,
        assignments: { exp_checkout: { runId: "run_1", variant: "control" } },
        assignmentWriterAssignments: {
          exp_checkout: { runId: "run_1", variant: "control" },
        },
        holdoverWrites: [{ environmentId: "env_prod", experimentId: "exp_checkout" }],
      },
    ];
    const analytics = [{ source: "metric_events", event_name: "purchased" }];
    const events = [{ store: "metric-event-outbox", deliveryId: "delivery_1" }];
    const consumer = createEntityPrivacyConsumer(
      service(() => ({
        ...IDENTITY,
        records: assignments,
        proofs: [
          `${HASH}:assignment-do-winners-exported-v1`,
          `${HASH}:assignment-and-holdover-exported-v1`,
        ],
        nextCursor: null,
      })),
      service((_path, body) => ({
        ...IDENTITY,
        records: analytics,
        nextCursor: body.cursor === null ? "analysis-next" : null,
        proofs: [
          "tinybird:raw_events:rows=0",
          "tinybird:metric_events:rows=1",
          "tinybird:deduped_exposures:rows=0",
          "tinybird:deduped_metric_events_state:rows=0",
        ],
      })),
      service((_path, body) => ({
        ...IDENTITY,
        records: events,
        nextCursor: body.cursor === null ? "events-next" : null,
        proofs: [
          "metric-event-outbox-inventory:rows=1",
          "evaluation-commit-outbox-inventory:rows=0",
        ],
      })),
    );

    const input = {
      appId: IDENTITY.appId,
      idType: IDENTITY.idType,
      targetingKey: "raw-key-never-in-artifact",
      actorId: "user_admin",
      orgId: "org_privacy",
      requestId: "request_privacy",
    };
    const identity = await consumer?.resolveIdentity(input);
    if (!identity) throw new Error("consumer is unavailable");
    const { targetingKey: _targetingKey, ...durableInput } = input;
    const resolved = { ...durableInput, ...identity };
    const assignmentsPage = await consumer?.exportAssignmentsPage(resolved, null, 100);
    const analysisPage = await consumer?.exportAnalysisPage(resolved, null, 100);
    const eventPage = await consumer?.exportEventsPage(resolved, null, 100);

    expect(identity).toEqual(IDENTITY);
    expect(assignmentsPage).toMatchObject({
      records: assignments,
      proofs: [
        `${HASH}:assignment-do-winners-exported-v1`,
        `${HASH}:assignment-and-holdover-exported-v1`,
      ],
    });
    expect(analysisPage).toMatchObject({ records: analytics, nextCursor: "analysis-next" });
    expect(eventPage).toMatchObject({ records: events, nextCursor: "events-next" });
    expect(JSON.stringify({ identity, assignmentsPage, analysisPage, eventPage })).not.toContain(
      "raw-key-never-in-artifact",
    );
  });
});
