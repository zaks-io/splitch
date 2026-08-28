import type { Env } from "./types";
import { evaluationCommitOutbox } from "./evaluation-commit-outbox";
import {
  atOrBefore,
  evaluationEntryGroups,
  evaluationEntryKey,
  entityStub,
  type EntityEvaluationInventoryEntry,
  type EntityMetricInventoryEntry,
  parseDeleteBefore,
  parseEntry,
  parseEvaluationEntry,
} from "./entity-metric-privacy";

const APP_ENTITY_PREFIX = "privacy:app-entity:";
const APP_RESET_SUPPRESSION_KEY = "privacy:app-reset-suppression";

interface AppEntityRef {
  appId: string;
  idType: string;
  entityFamilyHash: string;
}

interface AppResetSuppression {
  resetId: string;
}

const SUPPRESSION_KEY = "privacy:suppression";
const EVENT_PREFIX = "event:";
const EVALUATION_COMMIT_PREFIX = "evaluation-commit:";

interface SuppressionState {
  deleteBeforeTs: string;
}

export class EntityMetricPrivacyDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      return path === "/export" ? this.exportRecords() : new Response("not found", { status: 404 });
    }
    if (request.method === "POST") return this.write(path, request);
    return new Response("not found", { status: 404 });
  }

  private write(path: string, request: Request): Promise<Response> {
    const handlers: Record<string, () => Promise<Response>> = {
      "/register": () => this.register(request),
      "/register-evaluation": () => this.registerEvaluation(request),
      "/suppressed": () => this.suppressed(request),
      "/suppress": () => this.suppress(request),
      "/delete": () => this.deleteRecords(),
      "/register-app-entity": () => this.registerAppEntity(request),
      "/reset-app": () => this.resetApp(request),
      "/complete-reset": () => this.completeReset(request),
    };
    return handlers[path]?.() ?? Promise.resolve(new Response("not found", { status: 404 }));
  }

  private async registerAppEntity(request: Request): Promise<Response> {
    const ref = parseAppEntityRef(await request.json());
    if (await this.ctx.storage.get(APP_RESET_SUPPRESSION_KEY)) {
      return Response.json({ suppressed: true });
    }
    await this.ctx.storage.put(`${APP_ENTITY_PREFIX}${ref.idType}:${ref.entityFamilyHash}`, ref);
    return Response.json({ suppressed: false });
  }

  private async resetApp(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.appId !== "string" || typeof body.resetId !== "string") {
      throw new Error("App identity reset inventory input is invalid");
    }
    const existing = await this.ctx.storage.get<AppResetSuppression>(APP_RESET_SUPPRESSION_KEY);
    if (existing && existing.resetId !== body.resetId) {
      throw new Error("a different App identity reset is already running");
    }
    await this.ctx.storage.put(APP_RESET_SUPPRESSION_KEY, { resetId: body.resetId });
    const refs = await this.ctx.storage.list<AppEntityRef>({ prefix: APP_ENTITY_PREFIX });
    const cutoff = new Date().toISOString();
    for (const [key, ref] of refs) {
      const stub = entityStub(this.env.ENTITY_METRIC_PRIVACY, ref);
      const suppress = await stub.fetch("https://entity-privacy.local/suppress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteBeforeTs: cutoff }),
      });
      if (!suppress.ok)
        throw new Error(`App identity reset suppression returned ${suppress.status}`);
      const deleted = await stub.fetch("https://entity-privacy.local/delete", { method: "POST" });
      if (!deleted.ok) throw new Error(`App identity reset deletion returned ${deleted.status}`);
      await this.ctx.storage.delete(key);
    }
    return Response.json({ proof: `event-delivery:entities=${refs.size}` });
  }

  private async completeReset(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const existing = await this.ctx.storage.get<AppResetSuppression>(APP_RESET_SUPPRESSION_KEY);
    if (!existing || body.resetId !== existing.resetId) {
      throw new Error("App identity reset completion does not match suppression");
    }
    await this.ctx.storage.delete(APP_RESET_SUPPRESSION_KEY);
    return Response.json({ completed: true });
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
    const records = [
      ...(await this.exportMetricRecords(metricEntries)),
      ...(await this.exportEvaluationRecords(evaluationEntries)),
    ];
    return Response.json({
      records,
      proofs: [
        `metric-event-outbox-inventory:rows=${String(metricEntries.length)}`,
        `evaluation-commit-outbox-inventory:rows=${String(evaluationEntries.length)}`,
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

function parseAppEntityRef(value: unknown): AppEntityRef {
  if (typeof value !== "object" || value === null) {
    throw new Error("App Entity privacy inventory input is invalid");
  }
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.appId !== "string" ||
    typeof ref.idType !== "string" ||
    typeof ref.entityFamilyHash !== "string"
  ) {
    throw new Error("App Entity privacy inventory input is invalid");
  }
  return { appId: ref.appId, idType: ref.idType, entityFamilyHash: ref.entityFamilyHash };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
