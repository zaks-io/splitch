import { loadSentry } from "./sentry-module.js";

export type PerformanceSpanAttribute = string | number | boolean;

export interface PerformanceSpanDescriptor {
  readonly name: string;
  readonly op: string;
  readonly attributes?: Readonly<Record<string, PerformanceSpanAttribute>>;
}

export interface PerformanceSpanHandle {
  setAttribute(key: string, value: PerformanceSpanAttribute): void;
  setAttributes(attributes: Readonly<Record<string, PerformanceSpanAttribute>>): void;
}

export interface PerformanceSpanRecorder {
  record<T>(
    descriptor: PerformanceSpanDescriptor,
    run: (span: PerformanceSpanHandle) => Promise<T>,
  ): Promise<T>;
}

const noopHandle: PerformanceSpanHandle = {
  setAttribute() {},
  setAttributes() {},
};

export const noopPerformanceSpanRecorder: PerformanceSpanRecorder = {
  record(_descriptor, run) {
    return run(noopHandle);
  },
};

/** Record Worker work without loading Sentry in environments where it is disabled. */
export function createPerformanceSpanRecorder(env: {
  SENTRY_DSN?: string;
}): PerformanceSpanRecorder {
  return env.SENTRY_DSN ? sentryPerformanceSpanRecorder : noopPerformanceSpanRecorder;
}

/**
 * Record work beneath the active request transaction when the caller does not
 * own the Worker env, such as a shared service-binding transport.
 */
export const activePerformanceSpanRecorder: PerformanceSpanRecorder = {
  async record(descriptor, run) {
    const Sentry = await loadSentry();
    if (!Sentry.getActiveSpan()) return run(noopHandle);
    return recordWithSentry(Sentry, descriptor, run);
  },
};

const sentryPerformanceSpanRecorder: PerformanceSpanRecorder = {
  async record(descriptor, run) {
    return recordWithSentry(await loadSentry(), descriptor, run);
  },
};

async function recordWithSentry<T>(
  Sentry: Awaited<ReturnType<typeof loadSentry>>,
  descriptor: PerformanceSpanDescriptor,
  run: (span: PerformanceSpanHandle) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan(
    { name: descriptor.name, op: descriptor.op, attributes: descriptor.attributes },
    (span) =>
      run({
        setAttribute(key, value) {
          span.setAttribute(key, value);
        },
        setAttributes(attributes) {
          span.setAttributes(attributes);
        },
      }),
  );
}
