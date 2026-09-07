import type {
  PerformanceSpanAttribute,
  PerformanceSpanDescriptor,
  PerformanceSpanHandle,
  PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";

export interface RecordedPerformanceSpan {
  readonly descriptor: PerformanceSpanDescriptor;
  readonly attributes: Record<string, PerformanceSpanAttribute>;
}

export class RecordingPerformanceSpanRecorder implements PerformanceSpanRecorder {
  readonly records: RecordedPerformanceSpan[] = [];

  async record<T>(
    descriptor: PerformanceSpanDescriptor,
    run: (span: PerformanceSpanHandle) => Promise<T>,
  ): Promise<T> {
    const attributes = { ...descriptor.attributes };
    this.records.push({ descriptor, attributes });
    return run({
      setAttribute(key, value) {
        attributes[key] = value;
      },
      setAttributes(values) {
        Object.assign(attributes, values);
      },
    });
  }
}
