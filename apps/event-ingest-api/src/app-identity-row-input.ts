import { type AppEvaluationCommitRef, identityVersionForRow } from "./entity-metric-privacy";
import { deliveryPermitId } from "./raw-event-delivery-permit";

export interface AppEntityRef {
  appId: string;
  idType: string;
  entityFamilyHash: string;
  identityVersion: string;
}

export function parseAppEntityRef(value: unknown): AppEntityRef {
  if (!isRecord(value)) throw new Error("App Entity privacy inventory input is invalid");
  if (
    typeof value.appId !== "string" ||
    typeof value.idType !== "string" ||
    typeof value.entityFamilyHash !== "string" ||
    typeof value.identityVersion !== "string"
  ) {
    throw new Error("App Entity privacy inventory input is invalid");
  }
  return {
    appId: value.appId,
    idType: value.idType,
    entityFamilyHash: value.entityFamilyHash,
    identityVersion: value.identityVersion,
  };
}

export function parseAppEvaluationRef(value: unknown): AppEvaluationCommitRef {
  if (
    !isRecord(value) ||
    typeof value.appId !== "string" ||
    value.appId.length === 0 ||
    typeof value.commitIdentity !== "string" ||
    typeof value.identityVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.commitIdentity)
  ) {
    throw new Error("App Evaluation privacy inventory input is invalid");
  }
  return {
    appId: value.appId,
    commitIdentity: value.commitIdentity,
    identityVersion: value.identityVersion,
  };
}

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
