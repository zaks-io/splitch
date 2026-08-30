import { vi } from "vitest";

export interface RawEventQueueTestEnv {
  readonly __queuedRows: Record<string, unknown>[];
}

export function rawEventQueueBindings() {
  const queuedRows: Record<string, unknown>[] = [];
  const queue = {
    send: vi.fn(async (body: Record<string, unknown>) => {
      queuedRows.push(queueRow(body));
      return queueResult();
    }),
    sendBatch: vi.fn(async (messages: Iterable<{ body: Record<string, unknown> }>) => {
      for (const message of messages) queuedRows.push(queueRow(message.body));
      return queueResult();
    }),
    metrics: vi.fn(async () => queueResult().metadata.metrics),
  };
  return {
    RAW_EVENTS_QUEUE: queue,
    RAW_EVALUATIONS_QUEUE: queue,
    __queuedRows: queuedRows,
  };
}

export function captureQueuedResponse<Context, Fetch>(
  ctx: Context,
  fetch: Fetch,
  response: Response,
  env: RawEventQueueTestEnv,
  queuedStart: number,
) {
  return { ctx, fetch, response, rows: env.__queuedRows.slice(queuedStart) };
}

function queueRow(body: Record<string, unknown>): Record<string, unknown> {
  const row = body.row;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("expected raw queue envelope");
  }
  return row as Record<string, unknown>;
}

function queueResult() {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}
