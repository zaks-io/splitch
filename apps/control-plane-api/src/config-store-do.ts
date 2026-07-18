import { DurableObject } from "cloudflare:workers";
import {
  authorizesLiveUpdateConnection,
  type DeltaNudge,
  type LiveUpdateConnectionContext,
  parseLiveUpdateConnectionContext,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { type ConfigStoreWriter, makeConfigStore } from "./config-store";
import type { ControlPlaneApiEnv } from "./env";

export interface ConfigStoreDurableObjectNamespace {
  getByName(name: string): ConfigStoreDurableObjectStub;
}

interface ConfigStoreDurableObjectStub extends ConfigStoreWriter {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ConfigStoreLiveUpdates {
  connect(request: Request): Promise<Response>;
}

export interface ConfigStoreAccess {
  writerFor(appId: string, environmentId: string): ConfigStoreWriter;
  liveUpdatesFor(appId: string, environmentId: string): ConfigStoreLiveUpdates;
}

function configWriterName(appId: string, environmentId: string): string {
  return `${appId}:${environmentId}`;
}

export function durableConfigStoreAccess(
  namespace: ConfigStoreDurableObjectNamespace,
): ConfigStoreAccess {
  return {
    writerFor(appId, environmentId) {
      return namespace.getByName(configWriterName(appId, environmentId));
    },
    liveUpdatesFor(appId, environmentId) {
      return {
        connect(request) {
          return namespace.getByName(configWriterName(appId, environmentId)).fetch(request);
        },
      };
    },
  };
}

export class ConfigStoreDurableObject
  extends DurableObject<ControlPlaneApiEnv>
  implements ConfigStoreWriter
{
  readFlagConfig(
    input: Parameters<ConfigStoreWriter["readFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["readFlagConfig"]> {
    return this.store().readFlagConfig(input);
  }

  writeFlagConfig(
    input: Parameters<ConfigStoreWriter["writeFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["writeFlagConfig"]> {
    return this.store().writeFlagConfig(input);
  }

  replaceTargetingRules(
    input: Parameters<ConfigStoreWriter["replaceTargetingRules"]>[0],
  ): ReturnType<ConfigStoreWriter["replaceTargetingRules"]> {
    return this.store().replaceTargetingRules(input);
  }

  promoteFlagConfig(
    input: Parameters<ConfigStoreWriter["promoteFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["promoteFlagConfig"]> {
    return this.store().promoteFlagConfig(input);
  }

  syncExperimentConfig(
    input: Parameters<ConfigStoreWriter["syncExperimentConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["syncExperimentConfig"]> {
    return this.store().syncExperimentConfig(input);
  }

  resyncFlagConfig(
    input: Parameters<ConfigStoreWriter["resyncFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["resyncFlagConfig"]> {
    return this.store().resyncFlagConfig(input);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected WebSocket upgrade", { status: 426 });
    }

    const context = parseLiveUpdateConnectionContext(
      parseConnectionContextHeader(request.headers.get(LIVE_UPDATE_CONTEXT_HEADER)),
    );
    if (!context || !(await this.isAuthorized(context))) {
      return new Response("live update authorization required", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(context);
    this.ctx.acceptWebSocket(server);
    await this.rescheduleExpiryAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket): Promise<void> {
    await this.revalidate(socket);
  }

  override webSocketClose(): Promise<void> {
    return this.rescheduleExpiryAlarm();
  }

  override webSocketError(): void {}

  override async alarm(): Promise<void> {
    await Promise.all(this.ctx.getWebSockets().map((socket) => this.revalidate(socket)));
    await this.rescheduleExpiryAlarm();
  }

  private store(): ConfigStoreWriter {
    return makeConfigStore({
      repo: createRepository(this.env.DB),
      kv: this.env.CONFIG_STORE,
      broadcaster: { broadcast: (nudge) => this.broadcast(nudge) },
      logger: console,
    });
  }

  private broadcast(nudge: DeltaNudge): void {
    const payload = JSON.stringify(nudge);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (cause) {
        console.warn("config_store_live_update_send_failed", { cause });
      }
    }
  }

  private async revalidate(socket: WebSocket): Promise<void> {
    const context = parseLiveUpdateConnectionContext(socket.deserializeAttachment());
    if (!context || !(await this.isAuthorized(context))) {
      socket.close(AUTHORIZATION_POLICY_CLOSE_CODE, "live update authorization expired");
    }
  }

  private async isAuthorized(context: LiveUpdateConnectionContext): Promise<boolean> {
    try {
      const rawSession = await this.env.SESSION_STORE.get(
        `${PANEL_SESSION_KEY_PREFIX}${context.sessionTokenHash}`,
        "text",
      );
      return authorizesLiveUpdateConnection(rawSession, context);
    } catch {
      return false;
    }
  }

  private async rescheduleExpiryAlarm(): Promise<void> {
    const expiries = this.ctx
      .getWebSockets()
      .map((socket) => parseLiveUpdateConnectionContext(socket.deserializeAttachment())?.expiresAt)
      .filter((expiresAt): expiresAt is number => expiresAt !== undefined);
    const nextExpiry = Math.min(...expiries);
    if (Number.isFinite(nextExpiry)) {
      await this.ctx.storage.setAlarm(nextExpiry * 1_000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

export const LIVE_UPDATE_CONTEXT_HEADER = "x-splitch-live-update-context";
const AUTHORIZATION_POLICY_CLOSE_CODE = 1008;

const PANEL_SESSION_KEY_PREFIX = "session:";

function parseConnectionContextHeader(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
