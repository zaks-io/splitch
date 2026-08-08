import type { Env } from "./types";

export interface MetricEventRateLimitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

interface WindowState {
  readonly startedAt: number;
  readonly count: number;
}

const WINDOW_KEY = "metric-event-rate-window";
const WINDOW_MS = 1_000;

export class MetricEventRateLimitDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    if (!Number.isInteger(limit) || limit <= 0)
      return new Response("invalid limit", { status: 400 });
    const now = Date.now();
    const previous = await this.ctx.storage.get<WindowState>(WINDOW_KEY);
    const current =
      previous && now - previous.startedAt < WINDOW_MS ? previous : { startedAt: now, count: 0 };
    if (current.count >= limit) {
      return Response.json({ limited: true, retryAfterMs: WINDOW_MS - (now - current.startedAt) });
    }
    await this.ctx.storage.put(WINDOW_KEY, { ...current, count: current.count + 1 });
    return Response.json({ limited: false, retryAfterMs: 0 });
  }
}

export async function checkMetricEventRateLimit(
  namespace: MetricEventRateLimitNamespace | undefined,
  credentialHash: string,
  limit: number | null,
): Promise<{ limited: boolean; retryAfterMs: number }> {
  if (limit === null) return { limited: false, retryAfterMs: 0 };
  if (!namespace) throw new Error("METRIC_EVENT_RATE_LIMIT binding is unavailable");
  const id = namespace.idFromName(credentialHash);
  const response = await namespace
    .get(id)
    .fetch(`https://metric-event-rate.local/check?limit=${limit}`, { method: "POST" });
  if (!response.ok) throw new Error(`Metric Event rate limiter returned HTTP ${response.status}`);
  return (await response.json()) as { limited: boolean; retryAfterMs: number };
}
