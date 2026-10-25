import { DurableObject } from "cloudflare:workers";
import { createRepository, envScope } from "@splitch/db";
import {
  createWorkerFaultReporter,
  serializeFault,
  workerEmitter,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { integrationDeliveryMode } from "./control-plane-runtime-config";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";
import type { ControlPlaneApiEnv } from "./env";
import { integrationDeliverySummary, runIntegrationDelivery } from "./integration-delivery-run";

interface Identity {
  appId: string;
  environmentId: string;
}

export class IntegrationDeliveryDurableObject extends DurableObject<ControlPlaneApiEnv> {
  async wake(appId: string, environmentId: string): Promise<void> {
    envScope(appId, environmentId);
    await this.ctx.storage.transaction(async (storage) => {
      const identity = await storage.get<Identity>("identity");
      if (identity && (identity.appId !== appId || identity.environmentId !== environmentId)) {
        throw new Error("Integration delivery coordinator identity cannot change");
      }
      if (!identity) await storage.put("identity", { appId, environmentId });
      await setEarlierAlarm(storage, Date.now());
    });
  }

  override async alarm(): Promise<void> {
    const startedAt = Date.now();
    const summary = integrationDeliverySummary();
    let identity: Identity | undefined;
    let nextWakeAt: string | null = null;
    const options = workerObservabilityWithWaitUntil("control-plane-api", this.ctx);
    try {
      identity = await this.ctx.storage.get<Identity>("identity");
      if (!identity) throw new Error("Integration delivery alarm has no persisted identity");
      if (integrationDeliveryMode(this.env) === "coordinator") {
        const repo = createRepository(this.env.DB);
        const result = await runIntegrationDelivery({
          repo,
          scope: envScope(identity.appId, identity.environmentId),
          now: () => new Date(),
          summary,
          dispatchConvex: (scope, onDispatch) =>
            dispatchConvexWebhooks({
              repo,
              scope,
              onDispatch,
              webhookKek: this.env.CONVEX_WEBHOOK_KEK,
              webhookKeyVersion: this.env.CONVEX_WEBHOOK_KEY_VERSION,
            }),
          dispatchCloudflare: (scope, onDispatch) =>
            dispatchCloudflarePushes({
              repo,
              scope,
              onDispatch,
              secretKek: this.env.INTEGRATION_SECRET_KEK,
              secretKeyVersion: this.env.INTEGRATION_SECRET_KEY_VERSION,
            }),
        });
        nextWakeAt = result.nextWakeAt;
      }
      nextWakeAt = await this.#schedule(nextWakeAt);
    } catch (error) {
      nextWakeAt = new Date(Date.now() + 30_000).toISOString();
      try {
        nextWakeAt = await this.#schedule(nextWakeAt);
      } catch (scheduleError) {
        console.error("integration_delivery_alarm_schedule_failed", serializeFault(scheduleError));
      }
      try {
        createWorkerFaultReporter(this.env, options)("integration_delivery_run_failed", {
          ...identity,
          fault: serializeFault(error),
        });
      } catch (reportError) {
        console.error("integration_delivery_fault_report_failed", serializeFault(reportError));
      }
    }
    try {
      workerEmitter(this.env, options).log("info", "integration-delivery-run", {
        ...identity,
        ...summary,
        durationMs: Date.now() - startedAt,
        nextWakeAt,
      });
    } catch (logError) {
      console.error("integration_delivery_log_failed", serializeFault(logError));
    }
  }

  async #schedule(nextWakeAt: string | null): Promise<string | null> {
    // During alarm(), getAlarm() is null unless wake() has set a new alarm.
    // https://developers.cloudflare.com/durable-objects/api/alarms/#getalarm
    return this.ctx.storage.transaction(async (storage) => {
      if (nextWakeAt !== null) await setEarlierAlarm(storage, Date.parse(nextWakeAt));
      const alarm = await storage.getAlarm();
      return alarm === null ? null : new Date(alarm).toISOString();
    });
  }
}

async function setEarlierAlarm(storage: DurableObjectTransaction, wakeAt: number): Promise<void> {
  const existing = await storage.getAlarm();
  if (existing === null || wakeAt < existing) await storage.setAlarm(wakeAt);
}
