import { admitEntityIdentityRow, completeEntityIdentityRow } from "./entity-identity-row-delivery";
import {
  admitAppIdentityRow,
  completeAppIdentityRow,
  identityVersionForRow,
} from "./entity-metric-privacy";
import type { Env } from "./types";

type RawEventDatasource = "raw_events" | "raw_evaluations";

export async function admitRawEventPrivacy(
  datasource: RawEventDatasource,
  row: Record<string, unknown>,
  deliveryId: string,
  env: Env,
): Promise<boolean> {
  if (datasource === "raw_events") {
    return admitEntityIdentityRow(
      env.ENTITY_METRIC_PRIVACY,
      identityVersionForRow(row),
      datasource,
      row,
      env.SPLITCH_PLATFORM_TARGET,
      deliveryId,
    );
  }
  return admitAppIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    appId(row),
    identityVersionForRow(row),
    datasource,
    row,
    env.SPLITCH_PLATFORM_TARGET,
    deliveryId,
  );
}

export async function completeRawEventPrivacy(
  datasource: RawEventDatasource,
  row: Record<string, unknown>,
  deliveryId: string,
  env: Env,
): Promise<void> {
  if (datasource === "raw_events") {
    await completeEntityIdentityRow(
      env.ENTITY_METRIC_PRIVACY,
      identityVersionForRow(row),
      datasource,
      row,
      env.SPLITCH_PLATFORM_TARGET,
      deliveryId,
    );
    return;
  }
  await completeAppIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    appId(row),
    deliveryId,
    env.SPLITCH_PLATFORM_TARGET,
  );
}

function appId(row: Record<string, unknown>): string {
  const value = row.app_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("raw_evaluations row has no app_id");
  }
  return value;
}
