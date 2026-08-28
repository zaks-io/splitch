import { DurableObject } from "cloudflare:workers";
import {
  authorizesLiveUpdateConnection,
  type DeltaNudge,
  type LiveUpdateAuthorizationContext,
  type LiveUpdateConnectionContext,
  parseLiveUpdateConnectionContext,
} from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import { type ConfigStoreWriter, makeConfigStore } from "./config-store";
import { buildSnapshotFromD1 } from "./config-store-shared";
import type { ControlPlaneApiEnv } from "./env";
import type { EvaluationFlagConfigRead, EvaluationFlagConfigSnapshot } from "./config-store-access";

// biome-ignore lint/performance/noBarrelFile: preserve the existing DO import surface while keeping the access seam in a small file
export {
  type ConfigStoreAccess,
  type ConfigStoreDurableObjectNamespace,
  durableConfigStoreAccess,
  type EvaluationFlagConfigRead,
  type EvaluationFlagConfigSnapshot,
} from "./config-store-access";

export class ConfigStoreDurableObject
  extends DurableObject<ControlPlaneApiEnv>
  implements ConfigStoreWriter
{
  async readFlagConfigForEvaluation(
    input: EvaluationFlagConfigRead,
  ): Promise<EvaluationFlagConfigSnapshot | null> {
    const repo = createRepository(this.env.DB);
    const flag = await repo.flags.getFlagByKey(appScope(input.appId), input.flagKey);
    if (!flag) return null;
    const snapshot = await buildSnapshotFromD1(
      repo,
      envScope(input.appId, input.environmentId),
      flag.id,
    );
    return snapshot === null
      ? null
      : {
          flag: snapshot.flag,
          experiment: snapshot.experiment,
          run: snapshot.run,
          version: snapshot.version,
        };
  }

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

  previewFlagConfig(
    input: Parameters<ConfigStoreWriter["previewFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["previewFlagConfig"]> {
    return this.store().previewFlagConfig(input);
  }

  previewTargetingRules(
    input: Parameters<ConfigStoreWriter["previewTargetingRules"]>[0],
  ): ReturnType<ConfigStoreWriter["previewTargetingRules"]> {
    return this.store().previewTargetingRules(input);
  }

  previewPromotion(
    input: Parameters<ConfigStoreWriter["previewPromotion"]>[0],
  ): ReturnType<ConfigStoreWriter["previewPromotion"]> {
    return this.store().previewPromotion(input);
  }

  applyApprovedFlagConfig(
    input: Parameters<ConfigStoreWriter["applyApprovedFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["applyApprovedFlagConfig"]> {
    return this.store().applyApprovedFlagConfig(input);
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

  deleteFlagConfig(
    input: Parameters<ConfigStoreWriter["deleteFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["deleteFlagConfig"]> {
    return this.store().deleteFlagConfig(input);
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
    if ((await this.ctx.storage.get<boolean>(LIVE_UPDATES_AVAILABLE_KEY)) === false) {
      return new Response("live updates unavailable", { status: 503 });
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

  async setLiveUpdatesAvailable(available: boolean): Promise<void> {
    await this.ctx.storage.put(LIVE_UPDATES_AVAILABLE_KEY, available);
    if (available) return;
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(SERVICE_RESTART_CLOSE_CODE, "live update server unavailable");
    }
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

  private async isAuthorized(context: LiveUpdateAuthorizationContext): Promise<boolean> {
    if (!isPanelSessionContext(context)) return true;
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
      .map((socket) => parsePanelSessionContext(socket.deserializeAttachment())?.expiresAt)
      .filter((expiresAt): expiresAt is number => expiresAt !== undefined);
    const nextExpiry = Math.min(...expiries);
    if (Number.isFinite(nextExpiry)) {
      await this.ctx.storage.setAlarm(
        Math.min(nextExpiry * 1_000, Date.now() + SESSION_REVALIDATION_INTERVAL_MS),
      );
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

export const LIVE_UPDATE_CONTEXT_HEADER = "x-splitch-live-update-context";
const AUTHORIZATION_POLICY_CLOSE_CODE = 1008;

const PANEL_SESSION_KEY_PREFIX = "session:";
const SESSION_REVALIDATION_INTERVAL_MS = 60_000;
const LIVE_UPDATES_AVAILABLE_KEY = "liveUpdatesAvailable";
const SERVICE_RESTART_CLOSE_CODE = 1012;

function parseConnectionContextHeader(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePanelSessionContext(raw: unknown): LiveUpdateConnectionContext | null {
  const context = parseLiveUpdateConnectionContext(raw);
  return isPanelSessionContext(context) ? context : null;
}

function isPanelSessionContext(
  context: LiveUpdateAuthorizationContext | null,
): context is LiveUpdateConnectionContext {
  return context !== null && "sessionTokenHash" in context;
}
