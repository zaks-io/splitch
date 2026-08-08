import { appScope, createRepository } from "@splitch/db";

export async function ensureMetricEventDefinition(
  d1: D1Database,
  appId: string,
  name: string,
  nowIso: string,
  eventFieldName?: string,
): Promise<string> {
  const repo = createRepository(d1);
  const scope = appScope(appId);
  const existing = await repo.eventDefinitions.findByName(scope, name);
  if (existing) return existing.id;
  const id = `event_definition_${name}_${appId}`;
  const versionId = `event_definition_version_${name}_${appId}`;
  await repo.eventDefinitions.definitions.insert(scope, {
    id,
    appId,
    name,
    family: "metric",
    displayName: name,
    currentPublishedVersionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  await repo.eventDefinitions.publish(
    scope,
    {
      id: versionId,
      appId,
      eventDefinitionId: id,
      schemaHash: `sha256:${"a".repeat(64)}`,
      entityType: "user",
      fields: JSON.stringify(
        eventFieldName
          ? [{ name: eventFieldName, type: "number", required: true, numberKind: "float" }]
          : [],
      ),
      dimensions: "[]",
      publishedAt: nowIso,
    },
    nowIso,
    "test",
  );
  return id;
}
