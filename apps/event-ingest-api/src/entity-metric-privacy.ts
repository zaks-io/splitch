const EVALUATION_COMMIT_PREFIX = "evaluation-commit:";

export interface EntityMetricInventoryEntry {
  dedupKey: string;
  fingerprint: string;
  eventDefinitionId: string;
  eventDefinitionVersionId: string;
  targetingKeyHash: string;
  serverReceivedAt: string;
}

export interface EntityEvaluationInventoryEntry {
  commitIdentity: string;
  eventId: string;
  serverReceivedAt: string;
}

export interface AppEvaluationCommitRef {
  appId: string;
  commitIdentity: string;
}

export interface EntityMetricPrivacyNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export function appIdentityPrivacyInventoryStub(
  namespace: EntityMetricPrivacyNamespace | undefined,
  appId: string,
) {
  if (!namespace) throw new Error("ENTITY_METRIC_PRIVACY binding is unavailable");
  return namespace.get(namespace.idFromName(`${appId}:app-identity-inventory`));
}

export async function registerEntityMetricEvent(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identity: { appId: string; idType: string; entityFamilyHash: string },
  entry: EntityMetricInventoryEntry,
  platformTarget: string | undefined,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const inventoryResponse = await appIdentityPrivacyInventoryStub(namespace, identity.appId).fetch(
    "https://entity-privacy.local/register-app-entity",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity),
    },
  );
  if (!inventoryResponse.ok) {
    throw new Error(`App Entity privacy inventory returned HTTP ${inventoryResponse.status}`);
  }
  const inventoryResult = (await inventoryResponse.json()) as { suppressed?: unknown };
  if (inventoryResult.suppressed === true) return true;
  if (inventoryResult.suppressed !== false) {
    throw new Error("App Entity privacy inventory returned an invalid result");
  }
  return registerEntityEntry(namespace, identity, entry, platformTarget, "/register", "Metric");
}

export async function registerEntityEvaluationCommit(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identity: { appId: string; idType: string; entityFamilyHash: string },
  entry: EntityEvaluationInventoryEntry,
  platformTarget: string | undefined,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const inventoryResponse = await appIdentityPrivacyInventoryStub(namespace, identity.appId).fetch(
    "https://entity-privacy.local/register-app-entity",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity),
    },
  );
  if (!inventoryResponse.ok) {
    throw new Error(`App Entity privacy inventory returned HTTP ${inventoryResponse.status}`);
  }
  const inventoryResult = (await inventoryResponse.json()) as { suppressed?: unknown };
  if (inventoryResult.suppressed === true) return true;
  if (inventoryResult.suppressed !== false) {
    throw new Error("App Entity privacy inventory returned an invalid result");
  }
  return registerEntityEntry(
    namespace,
    identity,
    entry,
    platformTarget,
    "/register-evaluation",
    "Evaluation",
  );
}

export async function registerAppEvaluationCommit(
  namespace: EntityMetricPrivacyNamespace | undefined,
  ref: AppEvaluationCommitRef,
  platformTarget: string | undefined,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const response = await appIdentityPrivacyInventoryStub(namespace, ref.appId).fetch(
    "https://entity-privacy.local/register-app-evaluation",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ref),
    },
  );
  if (!response.ok) {
    throw new Error(`App Evaluation privacy inventory returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { suppressed?: unknown };
  if (typeof body.suppressed !== "boolean") {
    throw new Error("App Evaluation privacy inventory returned an invalid result");
  }
  return body.suppressed;
}

async function registerEntityEntry(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identity: { appId: string; idType: string; entityFamilyHash: string },
  entry: EntityMetricInventoryEntry | EntityEvaluationInventoryEntry,
  platformTarget: string | undefined,
  path: string,
  label: string,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const response = await entityStub(namespace, identity).fetch(
    `https://entity-privacy.local${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    },
  );
  if (!response.ok) throw new Error(`Entity ${label} inventory returned HTTP ${response.status}`);
  const body = (await response.json()) as { suppressed?: unknown };
  if (typeof body.suppressed !== "boolean") {
    throw new Error(`Entity ${label} inventory returned an invalid result`);
  }
  return body.suppressed;
}

export async function isEntityEventSuppressed(
  namespace: EntityMetricPrivacyNamespace | undefined,
  row: Record<string, unknown>,
  platformTarget: string | undefined,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const response = await entityStub(namespace, rowIdentity(row)).fetch(
    "https://entity-privacy.local/suppressed",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverReceivedAt: stringValue(row.server_received_at, "server_received_at"),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Entity Metric suppression lookup returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { suppressed?: unknown };
  if (typeof body.suppressed !== "boolean") {
    throw new Error("Entity Metric suppression returned an invalid result");
  }
  return body.suppressed;
}

export function entityStub(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identity: { appId: string; idType: string; entityFamilyHash: string },
) {
  if (!namespace) throw new Error("ENTITY_METRIC_PRIVACY binding is unavailable");
  const name = `${identity.appId}:${identity.idType}:${identity.entityFamilyHash}`;
  return namespace.get(namespace.idFromName(name));
}

export function parseEntry(value: unknown): EntityMetricInventoryEntry {
  if (!isRecord(value)) throw new Error("Entity Metric inventory entry is invalid");
  const entry = {
    dedupKey: stringValue(value.dedupKey, "dedupKey"),
    fingerprint: stringValue(value.fingerprint, "fingerprint"),
    eventDefinitionId: stringValue(value.eventDefinitionId, "eventDefinitionId"),
    eventDefinitionVersionId: stringValue(
      value.eventDefinitionVersionId,
      "eventDefinitionVersionId",
    ),
    targetingKeyHash: stringValue(value.targetingKeyHash, "targetingKeyHash"),
    serverReceivedAt: stringValue(value.serverReceivedAt, "serverReceivedAt"),
  };
  validateTimestamp(entry.serverReceivedAt, "Metric");
  return entry;
}

export function parseEvaluationEntry(value: unknown): EntityEvaluationInventoryEntry {
  if (!isRecord(value)) throw new Error("Entity Evaluation inventory entry is invalid");
  const entry = {
    commitIdentity: stringValue(value.commitIdentity, "commitIdentity"),
    eventId: stringValue(value.eventId, "eventId"),
    serverReceivedAt: stringValue(value.serverReceivedAt, "serverReceivedAt"),
  };
  if (!/^[a-f0-9]{64}$/u.test(entry.commitIdentity)) {
    throw new Error("Entity Evaluation commit identity is invalid");
  }
  validateTimestamp(entry.serverReceivedAt, "Evaluation");
  return entry;
}

export function evaluationEntryKey(entry: EntityEvaluationInventoryEntry): string {
  return `${EVALUATION_COMMIT_PREFIX}${entry.commitIdentity}:${entry.eventId}`;
}

export function evaluationEntryGroups(
  entries: readonly EntityEvaluationInventoryEntry[],
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const eventIds = groups.get(entry.commitIdentity) ?? [];
    eventIds.push(entry.eventId);
    groups.set(entry.commitIdentity, eventIds);
  }
  return groups;
}

export function parseDeleteBefore(value: unknown): string {
  if (!isRecord(value)) throw new Error("Entity Metric suppression request is invalid");
  const cutoff = stringValue(value.deleteBeforeTs, "deleteBeforeTs");
  validateTimestamp(cutoff, "Metric suppression cutoff");
  return new Date(Date.parse(cutoff)).toISOString();
}

export function atOrBefore(value: string, cutoff: string): boolean {
  return Date.parse(value) <= Date.parse(cutoff);
}

function rowIdentity(row: Record<string, unknown>) {
  return {
    appId: stringValue(row.app_id, "app_id"),
    idType: stringValue(row.id_type, "id_type"),
    entityFamilyHash: stringValue(row.entity_family_hash, "entity_family_hash"),
  };
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Entity ${label} timestamp is invalid`);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Entity Metric ${name} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
