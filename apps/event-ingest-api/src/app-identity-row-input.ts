import { identityVersionForRow } from "./entity-metric-privacy";
import { deliveryPermitId } from "./raw-event-delivery-permit";

export function parseEntityIdentityDelivery(value: Record<string, unknown>) {
  if (
    !isRecord(value.row) ||
    typeof value.appId !== "string" ||
    value.row.app_id !== value.appId ||
    typeof value.idType !== "string" ||
    value.row.id_type !== value.idType ||
    typeof value.entityFamilyHash !== "string" ||
    value.row.entity_family_hash !== value.entityFamilyHash ||
    typeof value.identityVersion !== "string" ||
    identityVersionForRow(value.row) !== value.identityVersion ||
    typeof value.datasource !== "string"
  ) {
    throw new Error("Entity identity delivery input is invalid");
  }
  return {
    row: value.row,
    datasource: value.datasource,
    deliveryId: deliveryPermitId(value),
    ref: {
      appId: value.appId,
      idType: value.idType,
      entityFamilyHash: value.entityFamilyHash,
      identityVersion: value.identityVersion,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
