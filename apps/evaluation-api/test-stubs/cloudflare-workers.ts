/**
 * Vitest-only stub for `cloudflare:workers` so unit tests can import `index.ts`
 * without the Workers runtime. Not used in production bundles.
 */
export class WorkerEntrypoint<Env = unknown> {
  readonly env: Env;
  readonly ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
