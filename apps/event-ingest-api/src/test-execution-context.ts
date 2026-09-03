export class TestExecutionContext implements ExecutionContext {
  readonly exports = {} as Cloudflare.Exports;
  readonly props = {};
  readonly tracing = {} as Tracing;
  waits: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waits.push(promise);
  }

  passThroughOnException(): void {}

  abort(reason?: unknown): never {
    throw reason instanceof Error
      ? reason
      : new Error(String(reason ?? "ExecutionContext aborted"));
  }
}
