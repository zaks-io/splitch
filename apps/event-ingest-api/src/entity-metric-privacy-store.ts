import {
  completeAppIdentityDeliveryReset,
  deliverAppIdentityRow,
  deliverEntityIdentityRow,
  registerAppEntity,
  registerAppEvaluation,
  resetAppIdentityDelivery,
} from "./app-identity-event-inventory";
import {
  atOrBefore,
  type EntityEvaluationInventoryEntry,
  type EntityMetricInventoryEntry,
  evaluationEntryGroups,
  evaluationEntryKey,
  parseDeleteBefore,
  parseEntry,
  parseEvaluationEntry,
} from "./entity-metric-privacy";
import { DeliveryResetLock } from "./delivery-reset-lock";
import { evaluationCommitOutbox } from "./evaluation-commit-outbox-client";
import { deliverEntityRowAtAuthority } from "./entity-identity-row-delivery";
import type { Env } from "./types";

const SUPPRESSION_KEY = "privacy:suppression";
const EVENT_PREFIX = "event:";
const EVALUATION_COMMIT_PREFIX = "evaluation-commit:";

interface SuppressionState {
  deleteBeforeTs: string;
}

export class EntityMetricPrivacyDurableObject {
  private readonly lock = new DeliveryResetLock();
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const route = this.route(request);
    if (!route) return new Response("not found", { status: 404 });
    return route.exclusive ? this.lock.exclusive(route.run) : this.lock.shared(route.run);
  }

  /**
   * Every route names whether it may overlap delivery. Reset, suppression,
   * deletion, and export mutate or read the whole inventory, so they run alone;
   * the rest are per-row and run concurrently. An unlisted path is a 404 rather
   * than a default, so a new route cannot silently inherit the weaker side.
   */
  private route(request: Request): Route | undefined {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      return path === "/export" ? alone(() => this.exportRecords()) : undefined;
    }
    if (request.method !== "POST") return undefined;
    const routes: Record<string, Route> = {
      "/register": concurrent(() => this.register(request)),
      "/register-evaluation": concurrent(() => this.registerEvaluation(request)),
      "/suppressed": concurrent(() => this.suppressed(request)),
      "/suppress": alone(() => this.suppress(request)),
      "/delete": alone(() => this.deleteRecords()),
      "/register-app-entity": concurrent(() => this.registerAppEntity(request)),
      "/register-app-evaluation": concurrent(() => this.registerAppEvaluation(request)),
      "/deliver-app-row": concurrent(() => this.deliverAppRow(request)),
      "/deliver-entity-row": concurrent(() => this.deliverEntityRow(request)),
      "/deliver-row": concurrent(() => this.deliverRow(request)),
      "/reset-app": alone(() => this.resetApp(request)),
      "/complete-reset": alone(() => this.completeReset(request)),
    };
    return routes[path];
  }

  private async registerAppEntity(request: Request): Promise<Response> {
    return registerAppEntity(this.ctx.storage, request);
  }

  private async registerAppEvaluation(request: Request): Promise<Response> {
    return registerAppEvaluation(this.ctx.storage, request);
  }

  private async deliverAppRow(request: Request): Promise<Response> {
    return deliverAppIdentityRow(this.ctx.storage, this.env, request);
  }

  private async deliverEntityRow(request: Request): Promise<Response> {
    return deliverEntityIdentityRow(this.ctx.storage, this.env, request);
  }

  private async deliverRow(request: Request): Promise<Response> {
    return deliverEntityRowAtAuthority(this.ctx.storage, this.env, request);
  }

  private async resetApp(request: Request): Promise<Response> {
    return resetAppIdentityDelivery(this.ctx.storage, this.env, request);
  }

  private async completeReset(request: Request): Promise<Response> {
    return completeAppIdentityDeliveryReset(this.ctx.storage, request);
  }

  private async register(request: Request): Promise<Response> {
    const entry = parseEntry(await request.json());
    const suppression = await this.ctx.storage.get<SuppressionState>(SUPPRESSION_KEY);
    if (suppression && atOrBefore(entry.serverReceivedAt, suppression.deleteBeforeTs)) {
      return Response.json({ suppressed: true });
    }
    await this.ctx.storage.put(`${EVENT_PREFIX}${entry.dedupKey}`, entry);
    return Response.json({ suppressed: false });
  }

  private async registerEvaluation(request: Request): Promise<Response> {
    const entry = parseEvaluationEntry(await request.json());
    const suppression = await this.ctx.storage.get<SuppressionState>(SUPPRESSION_KEY);
    if (suppression && atOrBefore(entry.serverReceivedAt, suppression.deleteBeforeTs)) {
      return Response.json({ suppressed: true });
    }
    await this.ctx.storage.put(evaluationEntryKey(entry), entry);
    return Response.json({ suppressed: false });
  }

  private async suppressed(request: Request): Promise<Response> {
    const body = (await request.json()) as { serverReceivedAt?: unknown };
    if (
      typeof body.serverReceivedAt !== "string" ||
      !Number.isFinite(Date.parse(body.serverReceivedAt))
    ) {
      return new Response("invalid serverReceivedAt", { status: 400 });
    }
    const suppression = await this.ctx.storage.get<SuppressionState>(SUPPRESSION_KEY);
    return Response.json({
      suppressed:
        suppression !== undefined && atOrBefore(body.serverReceivedAt, suppression.deleteBeforeTs),
    });
  }

  private async suppress(request: Request): Promise<Response> {
    const deleteBeforeTs = parseDeleteBefore(await request.json());
    const existing = await this.ctx.storage.get<SuppressionState>(SUPPRESSION_KEY);
    const effective =
      existing && Date.parse(existing.deleteBeforeTs) > Date.parse(deleteBeforeTs)
        ? existing.deleteBeforeTs
        : deleteBeforeTs;
    await this.ctx.storage.put(SUPPRESSION_KEY, { deleteBeforeTs: effective });
    return Response.json({
      proofs: [`metric-event-queue-suppression:${effective}`],
    });
  }

  private async exportRecords(): Promise<Response> {
    const metricEntries = await this.metricEntries();
    const evaluationEntries = await this.evaluationEntries();
    const metricRecords = await this.exportMetricRecords(metricEntries);
    const evaluationRecords = await this.exportEvaluationRecords(evaluationEntries);
    const records = [...metricRecords, ...evaluationRecords];
    return Response.json({
      records,
      proofs: [
        `metric-event-outbox-inventory:rows=${String(metricRecords.length)}`,
        `evaluation-commit-outbox-inventory:rows=${String(evaluationRecords.length)}`,
      ],
    });
  }

  private async exportMetricRecords(
    entries: readonly EntityMetricInventoryEntry[],
  ): Promise<Record<string, unknown>[]> {
    const records = [];
    for (const entry of entries) {
      const response = await this.outbox(entry.dedupKey).fetch(
        "https://metric-event-outbox.local/export",
      );
      if (response.status === 404) continue;
      if (!response.ok)
        throw new Error(`Metric Event outbox export returned HTTP ${response.status}`);
      const exported = (await response.json()) as { deleted?: unknown; row?: unknown };
      if (exported.deleted !== true && !isRecord(exported.row)) {
        throw new Error("Metric Event outbox export returned an invalid record");
      }
      if (isRecord(exported.row)) records.push(exported.row);
    }
    return records;
  }

  private async exportEvaluationRecords(
    entries: readonly EntityEvaluationInventoryEntry[],
  ): Promise<Record<string, unknown>[]> {
    const records = [];
    for (const [identity, eventIds] of evaluationEntryGroups(entries)) {
      records.push(...(await this.evaluationOutbox().privacyExport(identity, eventIds)));
    }
    return records;
  }

  private async deleteRecords(): Promise<Response> {
    const metricEntries = await this.metricEntries();
    const evaluationEntries = await this.evaluationEntries();
    const metricCount = await this.deleteMetricRecords(metricEntries);
    const evaluationCount = await this.deleteEvaluationRecords(evaluationEntries);
    await this.ctx.storage.delete([
      ...metricEntries.map((entry) => `${EVENT_PREFIX}${entry.dedupKey}`),
      ...evaluationEntries.map(evaluationEntryKey),
    ]);
    return Response.json({
      proofs: [
        `metric-event-outbox-redaction:count=${String(metricCount)}`,
        `evaluation-commit-outbox-redaction:count=${String(evaluationCount)}`,
        "metric-event-queue:protected-by-durable-cutoff",
      ],
    });
  }

  private async deleteMetricRecords(
    entries: readonly EntityMetricInventoryEntry[],
  ): Promise<number> {
    let deletedCount = 0;
    for (const entry of entries) {
      const response = await this.outbox(entry.dedupKey).fetch(
        "https://metric-event-outbox.local/suppress",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
        },
      );
      if (!response.ok)
        throw new Error(`Metric Event outbox deletion returned HTTP ${response.status}`);
      const result = (await response.json()) as { deleted?: unknown; proof?: unknown };
      if (
        result.deleted !== true ||
        typeof result.proof !== "string" ||
        result.proof.length === 0
      ) {
        throw new Error("Metric Event outbox deletion omitted its proof");
      }
      deletedCount += 1;
    }
    return deletedCount;
  }

  private async deleteEvaluationRecords(
    entries: readonly EntityEvaluationInventoryEntry[],
  ): Promise<number> {
    let deletedCount = 0;
    for (const [identity, eventIds] of evaluationEntryGroups(entries)) {
      deletedCount += await this.evaluationOutbox().privacyDelete(identity, eventIds);
    }
    return deletedCount;
  }

  private async metricEntries(): Promise<EntityMetricInventoryEntry[]> {
    return [
      ...(
        await this.ctx.storage.list<EntityMetricInventoryEntry>({ prefix: EVENT_PREFIX })
      ).values(),
    ];
  }

  private async evaluationEntries(): Promise<EntityEvaluationInventoryEntry[]> {
    return [
      ...(
        await this.ctx.storage.list<EntityEvaluationInventoryEntry>({
          prefix: EVALUATION_COMMIT_PREFIX,
        })
      ).values(),
    ];
  }

  private outbox(dedupKey: string) {
    const namespace = this.env.METRIC_EVENT_OUTBOX;
    if (!namespace) throw new Error("METRIC_EVENT_OUTBOX binding is unavailable");
    return namespace.get(namespace.idFromName(dedupKey));
  }

  private evaluationOutbox() {
    const outbox = evaluationCommitOutbox(this.env.EVALUATION_COMMIT_OUTBOX);
    if (!outbox) throw new Error("EVALUATION_COMMIT_OUTBOX binding is unavailable");
    return outbox;
  }
}

interface Route {
  exclusive: boolean;
  run: () => Promise<Response>;
}

function concurrent(run: () => Promise<Response>): Route {
  return { exclusive: false, run };
}

function alone(run: () => Promise<Response>): Route {
  return { exclusive: true, run };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
