import { appScope, createRepository } from "@splitch/db";

/**
 * Shape overrides for the published Version. Each one exists to drive a Run
 * Start refusal: a Version the Metric's binding no longer matches.
 */
export type MetricEventDefinitionOptions = {
  entityType?: string;
  /** `null` publishes a Version that declares no fields at all. */
  fieldName?: string | null;
  fieldType?: string;
  /** `false` leaves the Event Definition with no current published Version. */
  publish?: boolean;
};

export async function ensureMetricEventDefinition(
  d1: D1Database,
  appId: string,
  name: string,
  nowIso: string,
  eventFieldName?: string,
  options: MetricEventDefinitionOptions = {},
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
  if (options.publish === false) return id;
  const fieldName = options.fieldName === undefined ? eventFieldName : options.fieldName;
  await repo.eventDefinitions.publish(
    scope,
    {
      id: versionId,
      appId,
      eventDefinitionId: id,
      version: 1,
      schemaHash: `sha256:${"a".repeat(64)}`,
      entityType: options.entityType ?? "user",
      fields: JSON.stringify(
        fieldName
          ? [
              {
                name: fieldName,
                type: options.fieldType ?? "number",
                required: true,
                ...(options.fieldType && options.fieldType !== "number"
                  ? {}
                  : { numberKind: "float" }),
              },
            ]
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
