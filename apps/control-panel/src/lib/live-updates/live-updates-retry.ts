import type { DeltaNudge } from "@splitch/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { nudgeInvalidationPrefix } from "#lib/shared/query-keys";

/**
 * Convergence is a retry loop, not a single refetch: Workers KV is eventually
 * consistent, so the first invalidation after a nudge can still read the old
 * snapshot. These delays bound how long the panel keeps asking before it admits
 * the data on screen is stale.
 */
export const reconnectDelaysMs = [2_000, 4_000, 8_000] as const;
export const nudgeConvergenceDelaysMs = [2_000, 4_000, 8_000, 16_000, 32_000] as const;

export type RetryOptions = {
  cancellationSignal?: AbortSignal;
  delaysMs?: readonly number[];
  isCancelled?: () => boolean;
  isFresh?: () => boolean;
  onRetry?: (failure: { attempt: number; nextRetryMs: number }) => void;
  random?: () => number;
};

export function jitteredReconnectDelay(
  attempt: number,
  random = Math.random,
  delaysMs: readonly number[] = reconnectDelaysMs,
): number {
  const baseDelay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 8_000;
  return Math.round(baseDelay * (0.8 + random() * 0.4));
}

export async function invalidateWithRetry(
  queryClient: QueryClient,
  queryKey: ReturnType<(typeof nudgeInvalidationPrefix)[DeltaNudge["entity"]]>,
  options: RetryOptions = {},
  refetchRoute?: () => Promise<void>,
): Promise<boolean> {
  const delaysMs = options.delaysMs ?? reconnectDelaysMs;
  for (let retry = 0; retry <= delaysMs.length; retry += 1) {
    const result = await invalidateOnce(queryClient, queryKey, options, refetchRoute);
    if (result === "fresh") return true;
    if (result === "cancelled") return false;
    if (!(await waitForRetry(retry, delaysMs, options))) return false;
  }
  return false;
}

async function waitForRetry(
  retry: number,
  delaysMs: readonly number[],
  options: Pick<RetryOptions, "cancellationSignal" | "isCancelled" | "onRetry" | "random">,
): Promise<boolean> {
  const nextRetryMs = delaysMs[retry];
  if (nextRetryMs === undefined) return false;
  if (options.isCancelled?.()) return false;
  options.onRetry?.({ attempt: retry + 1, nextRetryMs });
  const elapsed = await wait(
    jitteredReconnectDelay(retry, options.random, delaysMs),
    options.cancellationSignal,
  );
  if (!elapsed) return false;
  return options.isCancelled?.() !== true;
}

async function invalidateOnce(
  queryClient: QueryClient,
  queryKey: ReturnType<(typeof nudgeInvalidationPrefix)[DeltaNudge["entity"]]>,
  options: Pick<RetryOptions, "isCancelled" | "isFresh">,
  refetchRoute?: () => Promise<void>,
): Promise<"cancelled" | "fresh" | "stale"> {
  if (options.isCancelled?.()) return "cancelled";
  try {
    await queryClient.invalidateQueries({ queryKey, refetchType: "all" }, { throwOnError: true });
    if (options.isCancelled?.()) return "cancelled";
    await refetchRoute?.();
    if (options.isCancelled?.()) return "cancelled";
    return options.isFresh?.() === false ? "stale" : "fresh";
  } catch {
    return options.isCancelled?.() ? "cancelled" : "stale";
  }
}

function wait(delay: number, cancellationSignal?: AbortSignal): Promise<boolean> {
  if (cancellationSignal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      cancellationSignal?.removeEventListener("abort", cancel);
      resolve(elapsed);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    cancellationSignal?.addEventListener("abort", cancel, { once: true });
  });
}
