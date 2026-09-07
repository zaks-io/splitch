import { createScrubbedEmitter, secretsFromEnv } from "@splitch/observability";
import {
  createPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";

type IngestTimingOutcome = "accepted" | "rejected" | "fault";

interface IngestTimingFields extends Record<string, unknown> {
  readonly serializedBytes: number | null;
  readonly itemCount?: number;
}

type IngestPhase =
  | "activationConfig"
  | "admission"
  | "admissionQueue"
  | "auth"
  | "config"
  | "delivery"
  | "event"
  | "identity"
  | "parse"
  | "queue"
  | "rateLimit"
  | "replay"
  | "row";

type IngestTimingRoute =
  | "internal_evaluation_usage"
  | "internal_exposure"
  | "raw_queue_settlement"
  | "sdk_metric_event";

export interface IngestPhaseTiming {
  measure<T>(phase: IngestPhase, run: () => T | Promise<T>): Promise<Awaited<T>>;
  emit(outcome: IngestTimingOutcome, fields: IngestTimingFields): void;
}

export function ingestTimingOutcomeFor(response: Response): IngestTimingOutcome {
  if (response.status >= 500) return "fault";
  return response.status >= 400 ? "rejected" : "accepted";
}

export function createIngestPhaseTiming(
  env: { SENTRY_DSN?: string; SPLITCH_PLATFORM_TARGET?: string },
  context: { route: IngestTimingRoute; stream: string },
  now: () => number = () => performance.now(),
  spans: PerformanceSpanRecorder = createPerformanceSpanRecorder(env),
): IngestPhaseTiming {
  const startedAt = now();
  const phaseDurations: Record<string, number> = {};
  const emitter = createScrubbedEmitter({
    ...secretsFromEnv(env),
    surface: "event-ingest-api",
    onStructuredLogEvents(events) {
      for (const event of events) console.info(event);
    },
  });
  return {
    async measure<T>(phase: IngestPhase, run: () => T | Promise<T>): Promise<Awaited<T>> {
      const phaseStartedAt = now();
      try {
        return await spans.record<Awaited<T>>(
          {
            name: `Event ingest ${context.route} ${phase}`,
            op: "event.ingest.phase",
          },
          () => Promise.resolve(run()),
        );
      } finally {
        phaseDurations[`${phase}Ms`] = milliseconds(now() - phaseStartedAt);
      }
    },
    emit(outcome, fields) {
      if (env.SPLITCH_PLATFORM_TARGET === "local") return;
      const { itemCount = 1, serializedBytes, ...details } = fields;
      emitter.log("info", "ingest_phase_timing", {
        ...details,
        ...context,
        outcome,
        itemCount,
        totalMs: milliseconds(now() - startedAt),
        ...phaseDurations,
        serializedBytes,
      });
    },
  };
}

function milliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}
