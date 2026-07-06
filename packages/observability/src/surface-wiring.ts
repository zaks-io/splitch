import { cliEmitter } from "./cli.js";
import { sdkHarnessEmitter } from "./sdk-harness.js";
import { workerEmitter } from "./worker.js";
import {
  OBSERVABILITY_SURFACES,
  type ObservabilitySurfaceId,
  type ObservabilitySurfaceKind,
} from "./surfaces.js";

const TEST_ENV = {
  SENTRY_DSN: "https://example@o0.ingest.sentry.io/0",
  SPLITCH_PLATFORM_TARGET: "local",
};

const WORKER_TEST_ENV = {
  SENTRY_DSN: TEST_ENV.SENTRY_DSN,
  SPLITCH_PLATFORM_TARGET: TEST_ENV.SPLITCH_PLATFORM_TARGET,
};

type SurfaceEmitterFactory = (hooks: {
  onSentryEvent?: (event: Record<string, unknown>) => void;
  onStructuredLogEvents?: (events: Record<string, unknown>[]) => void;
}) => {
  captureException: (error: unknown, extra?: Record<string, unknown>) => void;
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
};

const SURFACE_EMITTERS: Record<ObservabilitySurfaceId, SurfaceEmitterFactory> = {
  "control-plane-api": (hooks) =>
    workerEmitter(WORKER_TEST_ENV, { surface: "control-plane-api" }, hooks),
  "evaluation-api": (hooks) => workerEmitter(WORKER_TEST_ENV, { surface: "evaluation-api" }, hooks),
  "event-ingest-api": (hooks) =>
    workerEmitter(WORKER_TEST_ENV, { surface: "event-ingest-api" }, hooks),
  "analysis-api": (hooks) => workerEmitter(WORKER_TEST_ENV, { surface: "analysis-api" }, hooks),
  "auth-api": (hooks) => workerEmitter(WORKER_TEST_ENV, { surface: "auth-api" }, hooks),
  "control-panel": (hooks) => workerEmitter(WORKER_TEST_ENV, { surface: "control-panel" }, hooks),
  "mcp-server": (hooks) => workerEmitter(WORKER_TEST_ENV, { surface: "mcp-server" }, hooks),
  cli: (hooks) => cliEmitter(TEST_ENV, hooks),
  "sdk-harness": (hooks) => sdkHarnessEmitter(TEST_ENV, hooks),
};

export function createSurfaceEmitter(surface: ObservabilitySurfaceId): SurfaceEmitterFactory {
  return SURFACE_EMITTERS[surface];
}

export function surfaceKindFor(id: ObservabilitySurfaceId): ObservabilitySurfaceKind {
  const match = OBSERVABILITY_SURFACES.find((entry) => entry.id === id);
  if (!match) {
    throw new Error(`unknown surface ${id}`);
  }
  return match.kind;
}
