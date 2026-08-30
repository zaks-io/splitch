import {
  admitEntityIdentityRow,
  completeAppIdentityDeliveryReset,
  deliverAppIdentityRow,
  deliverEntityIdentityRow,
  registerAppEntity,
  registerAppEvaluation,
  resetAppIdentityDelivery,
} from "./app-identity-event-inventory";
import { DeliveryResetLock } from "./delivery-reset-lock";
import {
  admitEntityRowResponse,
  deliverEntityRowAtAuthority,
} from "./entity-identity-row-delivery";
import {
  atOrBefore,
  type EntityEvaluationInventoryEntry,
  type EntityMetricInventoryEntry,
  evaluationEntryKey,
  parseDeleteBefore,
  parseEntry,
  parseEvaluationEntry,
} from "./entity-metric-privacy";
import {
  deleteEvaluationRecords,
  deleteMetricRecords,
  exportEvaluationRecords,
  exportMetricRecords,
} from "./entity-metric-privacy-records";
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
      "/admit-entity-row": concurrent(() => this.admitEntityRow(request)),
      "/deliver-row": concurrent(() => this.deliverRow(request)),
      "/admit-row": concurrent(() => this.admitRow(request)),
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

  private async admitEntityRow(request: Request): Promise<Response> {
    return admitEntityIdentityRow(this.ctx.storage, this.env, request);
  }

  private async deliverRow(request: Request): Promise<Response> {
    return deliverEntityRowAtAuthority(this.ctx.storage, this.env, request);
  }

  private async admitRow(request: Request): Promise<Response> {
    return admitEntityRowResponse(this.ctx.storage, request);
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
    const metricRecords = await exportMetricRecords(this.env, await this.metricEntries());
    const evaluationRecords = await exportEvaluationRecords(
      this.env,
      await this.evaluationEntries(),
    );
    return Response.json({
      records: [...metricRecords, ...evaluationRecords],
      proofs: [
        `metric-event-outbox-inventory:rows=${String(metricRecords.length)}`,
        `evaluation-commit-outbox-inventory:rows=${String(evaluationRecords.length)}`,
      ],
    });
  }

  private async deleteRecords(): Promise<Response> {
    const metricEntries = await this.metricEntries();
    const evaluationEntries = await this.evaluationEntries();
    const metricCount = await deleteMetricRecords(this.env, metricEntries);
    const evaluationCount = await deleteEvaluationRecords(this.env, evaluationEntries);
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
