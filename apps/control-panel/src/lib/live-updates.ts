import type { DeltaNudge } from "@splitch/contracts";
import { DeltaNudgeSchema } from "@splitch/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { createNudgeRefetchFailureHandler } from "./panel-observability";
import { type AppEnvironmentScope, nudgeInvalidationPrefix, queryKeys } from "./query-keys";

const reconnectDelaysMs = [2_000, 4_000, 8_000] as const;
const nudgeConvergenceDelaysMs = [2_000, 4_000, 8_000, 16_000, 32_000] as const;

type LiveUpdateSocket = {
  close(): void;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => unknown) | null;
};
type SocketFactory = (url: string) => LiveUpdateSocket;
type Timer = ReturnType<typeof setTimeout>;

export type LiveUpdateConnectionOptions = {
  readonly createSocket?: SocketFactory;
  readonly onStaleDataChange?: (isStale: boolean) => void;
  readonly random?: () => number;
  readonly refetchRoute?: () => Promise<void>;
  readonly scope: AppEnvironmentScope;
  readonly url: string;
  readonly queryClient: QueryClient;
};

export class LiveUpdateConnection {
  private attempts = 0;
  private nextNudgeGeneration = 0;
  private readonly nudgeGenerations = new Map<string, number>();
  private reconnectTimer: Timer | undefined;
  private socket: LiveUpdateSocket | undefined;
  private readonly staleNudgeTargets = new Set<string>();
  private stopped = false;

  constructor(private readonly options: LiveUpdateConnectionOptions) {}

  start(): void {
    this.stopped = false;
    void this.refreshScope();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.nudgeGenerations.clear();
    this.staleNudgeTargets.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.options.queryClient.invalidateQueries({
      queryKey: queryKeys.app.root(this.options.scope.appId, this.options.scope.environmentId),
    });
  }

  private connect(): void {
    if (this.stopped) return;

    const socket = (this.options.createSocket ?? browserSocket)(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket || this.stopped) return;
      this.attempts = 0;
      void this.recoverAfterConnect(socket);
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || this.stopped) return;
      const nudge = parseNudge(event.data);
      if (!nudge) return;
      const target = `${nudge.entity}:${nudge.id}`;
      const generation = ++this.nextNudgeGeneration;
      this.nudgeGenerations.set(target, generation);
      const isCurrent = () =>
        generation === this.nudgeGenerations.get(target) && socket === this.socket && !this.stopped;
      void handleParsedNudge(nudge, this.options.scope, this.options.queryClient, {
        onStaleData: () => {
          if (!isCurrent()) return;
          this.staleNudgeTargets.add(target);
          this.options.onStaleDataChange?.(true);
        },
        onFreshData: () => {
          if (!isCurrent()) return;
          this.staleNudgeTargets.delete(target);
          this.options.onStaleDataChange?.(this.staleNudgeTargets.size > 0);
        },
        refetchRoute: this.options.refetchRoute,
      });
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (socket !== this.socket || this.stopped) return;
      this.nudgeGenerations.clear();
      this.staleNudgeTargets.clear();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = jitteredReconnectDelay(this.attempts, this.options.random);
    this.attempts += 1;
    if (this.attempts >= reconnectDelaysMs.length) this.options.onStaleDataChange?.(true);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async recoverAfterConnect(socket: LiveUpdateSocket): Promise<void> {
    const recovered = await this.refreshScope();
    if (socket !== this.socket || this.stopped) return;
    this.options.onStaleDataChange?.(!recovered);
  }

  private async refreshScope(): Promise<boolean> {
    return invalidateWithRetry(
      this.options.queryClient,
      queryKeys.app.root(this.options.scope.appId, this.options.scope.environmentId),
      {},
      this.options.refetchRoute,
    );
  }
}

export async function handleNudge(
  rawPayload: unknown,
  scope: AppEnvironmentScope,
  queryClient: QueryClient,
  options: {
    onFreshData?: () => void;
    onStaleData?: () => void;
    refetchRoute?: () => Promise<void>;
  } = {},
): Promise<void> {
  const parsed = parseNudge(rawPayload);
  if (!parsed) return;

  return handleParsedNudge(parsed, scope, queryClient, options);
}

async function handleParsedNudge(
  parsed: DeltaNudge,
  scope: AppEnvironmentScope,
  queryClient: QueryClient,
  options: {
    onFreshData?: () => void;
    onStaleData?: () => void;
    refetchRoute?: () => Promise<void>;
  },
): Promise<void> {
  const detailKey = nudgeDetailKey(parsed, scope);
  const detail = detailKey ? queryClient.getQueryData<{ version?: number }>(detailKey) : undefined;
  if (detail?.version !== undefined && detail.version >= parsed.version) {
    options.onFreshData?.();
    return;
  }

  await invalidateNudgeWithRetry(
    parsed,
    scope,
    queryClient,
    detail?.version === undefined ? null : detailKey,
    options,
  );
}

export function liveUpdateUrl(scope: { orgSlug: string; appSlug: string; env: string }): string {
  const url = new URL(
    `/${encodeURIComponent(scope.orgSlug)}/${encodeURIComponent(scope.appSlug)}/${encodeURIComponent(scope.env)}/live`,
    window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function jitteredReconnectDelay(attempt: number, random = Math.random): number {
  const baseDelay = reconnectDelaysMs[Math.min(attempt, reconnectDelaysMs.length - 1)] ?? 8_000;
  return Math.round(baseDelay * (0.8 + random() * 0.4));
}

async function invalidateNudgeWithRetry(
  nudge: DeltaNudge,
  scope: AppEnvironmentScope,
  queryClient: QueryClient,
  detailKey: readonly string[] | null,
  options: {
    onFreshData?: () => void;
    onStaleData?: () => void;
    refetchRoute?: () => Promise<void>;
  },
): Promise<void> {
  const prefix = nudgeInvalidationPrefix[nudge.entity](scope.appId, scope.environmentId);
  const reportFailure = createNudgeRefetchFailureHandler({
    entity: nudge.entity,
    id: nudge.id,
    onStaleData: () => options.onStaleData?.(),
  });

  const converged = await invalidateWithRetry(
    queryClient,
    prefix,
    {
      delaysMs: nudgeConvergenceDelaysMs,
      isFresh: detailKey
        ? () => {
            const refreshed = queryClient.getQueryData<{ version?: number }>(detailKey);
            return refreshed?.version !== undefined && refreshed.version >= nudge.version;
          }
        : undefined,
      onRetry: reportFailure,
    },
    options.refetchRoute,
  );
  if (converged) options.onFreshData?.();
}

async function invalidateWithRetry(
  queryClient: QueryClient,
  queryKey: ReturnType<(typeof nudgeInvalidationPrefix)[DeltaNudge["entity"]]>,
  options: {
    delaysMs?: readonly number[];
    isFresh?: () => boolean;
    onRetry?: (failure: { attempt: number; nextRetryMs: number }) => void;
  } = {},
  refetchRoute?: () => Promise<void>,
): Promise<boolean> {
  const delaysMs = options.delaysMs ?? reconnectDelaysMs;
  for (let retry = 0; retry <= delaysMs.length; retry += 1) {
    try {
      await queryClient.invalidateQueries({ queryKey, refetchType: "all" }, { throwOnError: true });
      await refetchRoute?.();
      if (options.isFresh?.() !== false) return true;
    } catch {
      // A failed refetch and a successful stale refetch both leave the cache unconfirmed.
    }
    if (retry === delaysMs.length) return false;
    const nextRetryMs = delaysMs[retry];
    if (nextRetryMs === undefined) return false;
    options.onRetry?.({ attempt: retry + 1, nextRetryMs });
    await wait(nextRetryMs);
  }
  return false;
}

function nudgeDetailKey(nudge: DeltaNudge, scope: AppEnvironmentScope): readonly string[] | null {
  switch (nudge.entity) {
    case "experiment":
      return queryKeys.experiment.detail(scope.appId, scope.environmentId, nudge.id);
    case "flag":
      return queryKeys.flag.detail(scope.appId, scope.environmentId, nudge.id);
    case "run":
      return null;
    case "segment":
      return queryKeys.segment.detail(scope.appId, scope.environmentId, nudge.id);
  }
}

function parseNudge(rawPayload: unknown): DeltaNudge | null {
  if (typeof rawPayload !== "string") {
    console.warn("Ignoring invalid live-update nudge payload");
    return null;
  }
  try {
    const parsed = DeltaNudgeSchema.safeParse(JSON.parse(rawPayload));
    if (parsed.success) return parsed.data;
    console.warn("Ignoring invalid live-update nudge payload");
  } catch {
    console.warn("Ignoring invalid live-update nudge payload");
  }
  return null;
}

function browserSocket(url: string): LiveUpdateSocket {
  return new WebSocket(url);
}

function wait(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}
