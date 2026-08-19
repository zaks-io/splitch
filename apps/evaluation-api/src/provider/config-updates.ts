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

interface Subscription {
  // Only plain state crosses requests. The WebSocket remains in the event
  // closures created by its originating request context, avoiding cross-request
  // access to a Workers I/O object.
  connected: boolean;
  connecting: boolean;
  listener: ConfigUpdateListener;
}

/** Evaluation-side client for the existing hibernating Config Store DO. */
export class DurableConfigUpdates {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly namespace: ConfigStoreNamespace,
    private readonly logger: Pick<Console, "error"> = console,
  ) {}

  async ensureSubscribed(
    appId: string,
    environmentId: string,
    listener: ConfigUpdateListener,
  ): Promise<void> {
    const key = scopeKey(appId, environmentId);
    const state = this.subscriptions.get(key) ?? {
      connected: false,
      connecting: false,
      listener,
    };
    state.listener = listener;
    this.subscriptions.set(key, state);

    if (state.connected) return;
    if (state.connecting) {
      throw new Error("config update subscription is still connecting");
    }
    state.connecting = true;
    try {
      await this.connect(appId, environmentId, state);
    } finally {
      state.connecting = false;
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
    socket.addEventListener("close", () => this.disconnect(state));
    socket.addEventListener("error", () => this.disconnect(state));
    socket.accept();
    state.connected = true;
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

  private disconnect(state: Subscription): void {
    state.connected = false;
  }

  private stub(appId: string, environmentId: string): ConfigStoreStub {
    return this.namespace.getByName(`${appId}:${environmentId}`);
  }
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
