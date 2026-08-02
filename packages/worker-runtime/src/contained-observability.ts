import type { Observability } from "./deps";

/**
 * Wrap an observability sink so no hook can affect the response.
 *
 * WHY at the seam and not at each call site: the guard reports through `onError`
 * from six places and calls `onRequest` before its own try block, so a
 * per-call-site guard is one refactor away from a hole. `Observability` already
 * promises that omitting a hook is silent rather than an error; this is what
 * makes a *throwing* hook obey the same promise, by construction.
 *
 * Both escapes are real. A throw from the `fail()` reporter lands in the fault
 * catch and turns a deterministic 400 into a 500 -- corrupting a correct answer,
 * which is worse than losing a fault report. A throw from `onRequest` escapes the
 * guard entirely and the caller gets Hono's plain-text default: no code, no
 * request id.
 */
export function containObservability(observability: Observability | undefined): Observability {
  return {
    onRequest: (ctx) => contain("onRequest", ctx.requestId, () => observability?.onRequest?.(ctx)),
    onError: (ctx) => contain("onError", ctx.requestId, () => observability?.onError?.(ctx)),
  };
}

/**
 * Contained, never silent -- but deliberately terse: only the hook, the request
 * id, and the fault's constructor name.
 *
 * The thrown text is withheld because worker-runtime has no scrubber, and the
 * sink that would have scrubbed it is precisely what just failed. A sink that
 * throws while handling a credential-bearing cause could otherwise route that
 * cause to the log by the shortest path available. Naming the broken hook is
 * enough to act on: observability is down, and that is the finding.
 */
function contain(hook: string, requestId: string, call: () => void): void {
  try {
    call();
  } catch (reportingFault) {
    const fault = reportingFault instanceof Error ? reportingFault.name : typeof reportingFault;
    console.error(`worker-runtime: observability.${hook} threw`, { requestId, fault });
  }
}
