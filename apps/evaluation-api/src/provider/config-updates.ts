import {
  type DeltaNudge,
  DeltaNudgeSchema,
  type ExperimentConfigKV,
  type FlagConfigKV,
  type RunConfigKV,
} from "@splitch/contracts";

export interface EvaluationConfigSnapshot {
  experiment: ExperimentConfigKV | null;
  flag: FlagConfigKV;
  run: RunConfigKV | null;
  version: number;
}

interface ConfigStoreStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readFlagConfigForEvaluation(input: {
    appId: string;
    environmentId: string;
    flagKey: string;
  }): Promise<EvaluationConfigSnapshot | null>;
}

export interface ConfigStoreNamespace {
  getByName(name: string): ConfigStoreStub;
}

export interface ConfigUpdateListener {
  onNudge(nudge: DeltaNudge): void;
  onReconnect(): void;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * The platform cancels a `ctx.waitUntil` promise about 30 seconds after its
 * request responds. Re-subscribe below that bound so a request always runs on a
 * socket whose I/O context is still alive.
 * https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil
 */
const PIN_WINDOW_MS = 25_000;

interface Subscription {
  // waitUntil on the connecting request keeps the socket's I/O context alive
  // across later isolate requests until close/error. Concurrent cold reads share
  // one connect promise so siblings await readiness instead of failing loud.
  connected: boolean;
  connecting: Promise<void> | undefined;
  // Sticky: a subscription that ever worked degrades gracefully for the whole
  // outage, not just its first failing request.
  everConnected: boolean;
  listener: ConfigUpdateListener;
  pinnedAt: number;
  socket: WebSocket | undefined;
}

/** Evaluation-side client for the existing hibernating Config Store DO. */
export class DurableConfigUpdates {
  private readonly subscriptions = new Map<string, Subscription>();
  private waitUntil: WaitUntil | undefined;

  constructor(
    private readonly namespace: ConfigStoreNamespace,
    private readonly logger: Pick<Console, "error"> = console,
    private readonly now: () => number = Date.now,
  ) {}

  /** Refresh the per-request waitUntil seam used to pin open live-update sockets. */
  setWaitUntil(waitUntil: WaitUntil | undefined): void {
    this.waitUntil = waitUntil;
  }

  async ensureSubscribed(
    appId: string,
    environmentId: string,
    listener: ConfigUpdateListener,
  ): Promise<void> {
    const key = scopeKey(appId, environmentId);
    const state = this.subscriptions.get(key) ?? {
      connected: false,
      connecting: undefined,
      everConnected: false,
      listener,
      pinnedAt: 0,
      socket: undefined,
    };
    state.listener = listener;
    this.subscriptions.set(key, state);

    if (state.connected && this.now() - state.pinnedAt < PIN_WINDOW_MS) return;
    if (state.connecting !== undefined) return state.connecting;

    // A pin older than the window has been canceled, which kills the socket's
    // I/O context without ever firing close or error, so `connected` is not
    // liveness. Reconnect and re-pin on the request that got us here.
    const reSubscribe = state.everConnected;
    state.connected = false;
    const connecting = this.connect(appId, environmentId, state);
    state.connecting = connecting;
    try {
      await connecting;
    } catch (cause) {
      if (!reSubscribe) throw cause;
      // The nudge channel is down but the authoritative Config Store read is
      // not, so drop the Environment cache and let reads go to the DO rather
      // than serve a value nothing can invalidate.
      this.logger.error("evaluation_config_resubscribe_failed", {
        appId,
        environmentId,
        cause,
      });
      state.listener.onReconnect();
    } finally {
      if (state.connecting === connecting) state.connecting = undefined;
    }
  }

  readCurrentFlagConfig(
    appId: string,
    environmentId: string,
    flagKey: string,
  ): Promise<EvaluationConfigSnapshot | null> {
    return this.stub(appId, environmentId).readFlagConfigForEvaluation({
      appId,
      environmentId,
      flagKey,
    });
  }

  private async connect(appId: string, environmentId: string, state: Subscription): Promise<void> {
    const response = await this.stub(appId, environmentId).fetch(
      "https://config-store.internal/live",
      {
        headers: {
          upgrade: "websocket",
          "x-splitch-live-update-context": JSON.stringify({
            version: 1,
            authentication: "control-plane",
            principalId: "evaluation-api",
            appId,
            environmentId,
          }),
        },
      },
    );
    const socket = response.webSocket;
    if (response.status !== 101 || socket === null) {
      throw new Error(`config update subscription refused with status ${response.status}`);
    }

    socket.addEventListener("message", (event) => this.receive(state, socket, event.data));
    socket.addEventListener("close", () => this.disconnect(state, socket));
    socket.addEventListener("error", () => this.disconnect(state, socket));
    socket.accept();
    state.socket = socket;
    state.connected = true;
    state.everConnected = true;
    // Pin the originating request's I/O context for the socket lifetime so
    // DeltaNudge delivery survives across Evaluation requests in this isolate.
    state.pinnedAt = this.now();
    this.waitUntil?.(untilSocketClosed(socket));
    state.listener.onReconnect();
  }

  private receive(state: Subscription, socket: WebSocket, raw: unknown): void {
    const parsed = parseNudge(raw);
    if (parsed === null) {
      this.logger.error("evaluation_config_nudge_invalid");
      socket.close(1003, "invalid config nudge");
      return;
    }
    state.listener.onNudge(parsed);
  }

  private disconnect(state: Subscription, socket: WebSocket): void {
    // A superseded socket can still emit close; it must not retire the live one.
    if (state.socket !== socket) return;
    state.connected = false;
  }

  private stub(appId: string, environmentId: string): ConfigStoreStub {
    return this.namespace.getByName(`${appId}:${environmentId}`);
  }
}

function untilSocketClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    socket.addEventListener("close", done);
    socket.addEventListener("error", done);
  });
}

function parseNudge(raw: unknown): DeltaNudge | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = DeltaNudgeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function scopeKey(appId: string, environmentId: string): string {
  return `${appId}\u0000${environmentId}`;
}
