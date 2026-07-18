import type { DeltaNudge } from "@splitch/contracts";
import { DeltaNudgeSchema } from "@splitch/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { createNudgeRefetchFailureHandler } from "./panel-observability";
import { type AppEnvironmentScope, nudgeInvalidationPrefix, queryKeys } from "./query-keys";

const reconnectDelaysMs = [2_000, 4_000, 8_000] as const;
const sessionRevalidationIntervalMs = 60_000;

type LiveUpdateSocket = {
  close(): void;
  send?(message: string): void;
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
  readonly scope: AppEnvironmentScope;
  readonly url: string;
  readonly queryClient: QueryClient;
};

export class LiveUpdateConnection {
  private attempts = 0;
  private revalidationTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private socket: LiveUpdateSocket | undefined;
  private stopped = false;

  constructor(private readonly options: LiveUpdateConnectionOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopSessionRevalidation();
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
      this.startSessionRevalidation(socket);
      this.options.onStaleDataChange?.(false);
      void this.options.queryClient.invalidateQueries({
        queryKey: queryKeys.app.root(this.options.scope.appId, this.options.scope.environmentId),
      });
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || this.stopped) return;
      void handleNudge(event.data, this.options.scope, this.options.queryClient, {
        onStaleData: () => this.options.onStaleDataChange?.(true),
      });
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (socket !== this.socket || this.stopped) return;
      this.stopSessionRevalidation();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = jitteredReconnectDelay(this.attempts, this.options.random);
    this.attempts += 1;
    if (this.attempts >= reconnectDelaysMs.length) this.options.onStaleDataChange?.(true);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startSessionRevalidation(socket: LiveUpdateSocket): void {
    this.stopSessionRevalidation();
    if (!socket.send) return;
    this.revalidationTimer = setInterval(() => {
      if (socket !== this.socket || this.stopped) return;
      try {
        socket.send?.("revalidate");
      } catch {
        socket.close();
      }
    }, sessionRevalidationIntervalMs);
  }

  private stopSessionRevalidation(): void {
    if (this.revalidationTimer) clearInterval(this.revalidationTimer);
    this.revalidationTimer = undefined;
  }
}

export async function handleNudge(
  rawPayload: unknown,
  scope: AppEnvironmentScope,
  queryClient: QueryClient,
  options: { onStaleData?: () => void } = {},
): Promise<void> {
  const parsed = parseNudge(rawPayload);
  if (!parsed) return;
  if (!isInvalidatableEntity(parsed.entity)) {
    console.warn(`Ignoring live-update nudge for unsupported entity "${parsed.entity}"`);
    return;
  }

  const detail = queryClient.getQueryData<{ version?: number }>(
    queryKeys[parsed.entity].detail(scope.appId, scope.environmentId, parsed.id),
  );
  if (detail?.version !== undefined && detail.version >= parsed.version) return;

  await invalidateNudgeWithRetry(parsed, scope, queryClient, options.onStaleData);
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
  onStaleData: (() => void) | undefined,
): Promise<void> {
  const prefix = nudgeInvalidationPrefix[nudge.entity as InvalidatableNudgeEntity](
    scope.appId,
    scope.environmentId,
  );
  const reportFailure = createNudgeRefetchFailureHandler({
    entity: nudge.entity,
    id: nudge.id,
    onStaleData: () => onStaleData?.(),
  });

  for (let attempt = 0; attempt < reconnectDelaysMs.length; attempt += 1) {
    try {
      await queryClient.invalidateQueries({ queryKey: prefix }, { throwOnError: true });
      return;
    } catch {
      const nextRetryMs = reconnectDelaysMs[attempt + 1];
      reportFailure({ attempt: attempt + 1, nextRetryMs });
      if (nextRetryMs === undefined) return;
      await wait(jitteredReconnectDelay(attempt + 1));
    }
  }
}

type InvalidatableNudgeEntity = Extract<DeltaNudge["entity"], keyof typeof nudgeInvalidationPrefix>;

function isInvalidatableEntity(entity: DeltaNudge["entity"]): entity is InvalidatableNudgeEntity {
  return entity in nudgeInvalidationPrefix;
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
