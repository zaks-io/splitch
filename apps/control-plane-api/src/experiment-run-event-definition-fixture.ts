import { appScope, type Repository } from "@splitch/db";
import { NOW_ISO } from "./flag-definition-test-harness";

export async function insertExperimentRunEventDefinition(
  repo: Repository,
  appId: string,
): Promise<void> {
  await repo.eventDefinitions.definitions.insert(appScope(appId), {
    id: "event_definition_signed_up",
    appId,
    name: "signed_up",
    family: "metric",
    displayName: "Signed up",
    currentPublishedVersionId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}
