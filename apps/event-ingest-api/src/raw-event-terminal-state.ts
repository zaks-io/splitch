import type { EntityMetricPrivacyNamespace } from "./entity-metric-privacy";
import type { Env } from "./types";

const DELIVERY_STATE_KEY = "raw-delivery-state";
const DELIVERY_OBJECT_MARKER = "raw-delivery-object";
const DELIVERY_RETENTION_MS = 15 * 24 * 60 * 60 * 1_000;
const LOST_ATTEMPT_REASON = "previous Tinybird attempt has no durable outcome";

type StoredDeliveryState =
  | { readonly kind: "attempting" }
  | { readonly kind: "retryable" }
  | { readonly kind: "delivered" }
  | ({ readonly kind: "terminal" } & RawEventTerminalState);

export interface RawEventTerminalState {
  readonly classification: "indeterminate" | "poison";
  readonly reason: string;
  readonly transferred: boolean;
}

export type RawEventAttempt =
  | { readonly kind: "send" }
  | { readonly kind: "delivered" }
  | { readonly kind: "terminal"; readonly state: RawEventTerminalState };

export async function beginRawEventAttemptAtAuthority(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  parseDeliveryId(await request.json());
  const existing = await storage.get<StoredDeliveryState>(DELIVERY_STATE_KEY);
  if (existing === undefined || existing.kind === "retryable") {
    await storeState(storage, { kind: "attempting" });
    return Response.json({ kind: "send" });
  }
  if (existing.kind === "attempting") {
    const terminal: StoredDeliveryState = {
      kind: "terminal",
      classification: "indeterminate",
      reason: LOST_ATTEMPT_REASON,
      transferred: false,
    };
    await storeState(storage, terminal);
    return Response.json(terminal);
  }
  return Response.json(existing);
}

export async function recordRawEventOutcome(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  parseDeliveryId(body);
  const proposed = parseOutcome(body);
  const existing = await storage.get<StoredDeliveryState>(DELIVERY_STATE_KEY);
  if (sameOutcome(existing, proposed)) return Response.json({ recorded: true });
  if (existing?.kind !== "attempting") {
    throw new Error("Raw event outcome has no matching active attempt");
  }
  await storeState(storage, proposed);
  return Response.json({ recorded: true });
}

export async function recordRawEventTransferred(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  parseDeliveryId(await request.json());
  const existing = await storage.get<StoredDeliveryState>(DELIVERY_STATE_KEY);
  if (existing?.kind !== "terminal") throw new Error("Raw event terminal marker is unavailable");
  if (!existing.transferred) await storeState(storage, { ...existing, transferred: true });
  return Response.json({ recorded: true });
}

export async function cleanupRawEventDeliveryState(storage: DurableObjectStorage): Promise<void> {
  if ((await storage.get(DELIVERY_OBJECT_MARKER)) !== true) return;
  await storage.deleteAlarm();
  await storage.deleteAll();
}

export async function beginRawEventAttempt(
  env: Env,
  row: Record<string, unknown>,
  deliveryId: string,
): Promise<RawEventAttempt> {
  if (!env.ENTITY_METRIC_PRIVACY && localTarget(env)) return { kind: "send" };
  const body = await post(env, row, "/begin-raw-attempt", { deliveryId });
  if (body.kind === "send" || body.kind === "delivered") return { kind: body.kind };
  if (body.kind !== "terminal") throw new Error("Raw event attempt returned an invalid result");
  return { kind: "terminal", state: parseTerminal(body) };
}

export async function markRawEventDelivered(
  env: Env,
  row: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  await markOutcome(env, row, { deliveryId, kind: "delivered" });
}

export async function markRawEventRetryable(
  env: Env,
  row: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  await markOutcome(env, row, { deliveryId, kind: "retryable" });
}

export async function markRawEventTerminal(
  env: Env,
  row: Record<string, unknown>,
  deliveryId: string,
  terminal: Omit<RawEventTerminalState, "transferred">,
): Promise<void> {
  await markOutcome(env, row, { deliveryId, kind: "terminal", ...terminal });
}

export async function markRawEventTransferred(
  env: Env,
  row: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  if (!env.ENTITY_METRIC_PRIVACY && localTarget(env)) return;
  await post(env, row, "/mark-raw-transferred", { deliveryId });
}

async function markOutcome(
  env: Env,
  row: Record<string, unknown>,
  outcome: Record<string, unknown>,
): Promise<void> {
  if (!env.ENTITY_METRIC_PRIVACY && localTarget(env)) return;
  await post(env, row, "/mark-raw-outcome", outcome);
}

async function post(
  env: Env,
  row: Record<string, unknown>,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const deliveryId = parseDeliveryId(body);
  const response = await rawDeliveryStateStub(
    env.ENTITY_METRIC_PRIVACY,
    appId(row),
    deliveryId,
  ).fetch(`https://entity-privacy.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Raw event delivery state returned HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!isRecord(result)) throw new Error("Raw event delivery state returned an invalid result");
  return result;
}

async function storeState(
  storage: DurableObjectStorage,
  state: StoredDeliveryState,
): Promise<void> {
  await storage.put(DELIVERY_OBJECT_MARKER, true);
  await storage.put(DELIVERY_STATE_KEY, state);
  await storage.setAlarm(Date.now() + DELIVERY_RETENTION_MS);
}

function rawDeliveryStateStub(
  namespace: EntityMetricPrivacyNamespace | undefined,
  appIdValue: string,
  deliveryId: string,
) {
  if (!namespace) throw new Error("ENTITY_METRIC_PRIVACY binding is unavailable");
  return namespace.get(namespace.idFromName(`${appIdValue}:raw-delivery-state:${deliveryId}`));
}

function parseOutcome(value: Record<string, unknown>): StoredDeliveryState {
  if (value.kind === "delivered" || value.kind === "retryable") return { kind: value.kind };
  if (value.kind === "terminal") return { kind: "terminal", ...parseTerminal(value) };
  throw new Error("Raw event outcome is invalid");
}

function parseTerminal(value: Record<string, unknown>): RawEventTerminalState {
  if (
    (value.classification !== "indeterminate" && value.classification !== "poison") ||
    typeof value.reason !== "string" ||
    (value.transferred !== undefined && typeof value.transferred !== "boolean")
  ) {
    throw new Error("Raw event terminal state is invalid");
  }
  return {
    classification: value.classification,
    reason: value.reason,
    transferred: value.transferred === true,
  };
}

function sameOutcome(
  existing: StoredDeliveryState | undefined,
  proposed: StoredDeliveryState,
): boolean {
  if (existing?.kind !== proposed.kind) return false;
  if (existing.kind !== "terminal" || proposed.kind !== "terminal") return true;
  return existing.classification === proposed.classification && existing.reason === proposed.reason;
}

function parseDeliveryId(value: unknown): string {
  if (!isRecord(value) || typeof value.deliveryId !== "string" || value.deliveryId.length === 0) {
    throw new Error("Raw event delivery id is invalid");
  }
  return value.deliveryId;
}

function appId(row: Record<string, unknown>): string {
  if (typeof row.app_id !== "string" || row.app_id.length === 0) {
    throw new Error("Raw event row has no app_id");
  }
  return row.app_id;
}

function localTarget(env: Env): boolean {
  return env.SPLITCH_PLATFORM_TARGET === "local" || env.SPLITCH_PLATFORM_TARGET === "pr-ci";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
