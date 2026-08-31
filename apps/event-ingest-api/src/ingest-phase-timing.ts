import { createScrubbedEmitter, secretsFromEnv } from "@splitch/observability";

type IngestTimingOutcome = "accepted" | "rejected" | "fault";

interface IngestTimingFields extends Record<string, unknown> {
  readonly serializedBytes: number | null;
  readonly itemCount?: number;
}

export interface IngestPhaseTiming {
  measure<T>(phase: string, run: () => T | Promise<T>): Promise<T>;
  emit(outcome: IngestTimingOutcome, fields: IngestTimingFields): void;
}

export function createIngestPhaseTiming(
  env: { SENTRY_DSN?: string; SPLITCH_PLATFORM_TARGET?: string },
  context: { route: string; stream: string },
  now: () => number = () => performance.now(),
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
    async measure(phase, run) {
      const phaseStartedAt = now();
      try {
        return await run();
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
