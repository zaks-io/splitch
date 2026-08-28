export function entityMetricPrivacyFixtureFetch(input: RequestInfo | URL): Promise<Response> {
  const responses: Record<string, unknown> = {
    "/register-app-entity": { suppressed: false },
    "/register": { suppressed: false },
    "/register-evaluation": { suppressed: false },
    "/suppressed": { suppressed: false },
    "/export": {
      records: [],
      proofs: ["metric-event-outbox-inventory:rows=0", "evaluation-commit-outbox-inventory:rows=0"],
    },
    "/suppress": { proofs: ["metric-event-queue-suppression:test"] },
    "/delete": {
      proofs: [
        "metric-event-outbox-redaction:count=0",
        "evaluation-commit-outbox-redaction:count=0",
        "metric-event-queue:protected-by-durable-cutoff",
      ],
    },
  };
  const value = responses[new URL(String(input)).pathname];
  return Promise.resolve(
    value === undefined ? new Response("not found", { status: 404 }) : Response.json(value),
  );
}
