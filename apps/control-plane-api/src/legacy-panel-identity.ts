import type { ControlPanelOperation } from "@splitch/control-plane-sdk/control-panel-identity";

export const LEGACY_CONTROL_PANEL_IDENTITY_HEADER = "x-splitch-panel-identity";

interface LegacyPanelIdentity {
  version: 1;
  operation: ControlPanelOperation;
  actorId: string;
  expiresAt: number;
  nonce: string;
}

const MAX_IDENTITY_LIFETIME_SECONDS = 30;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/** Parse the retired unsigned protocol only during the bounded V1-to-V2 deploy transition. */
export function parseBoundedLegacyPanelIdentity(
  value: string | null,
  expectedOperation: ControlPanelOperation,
  nowSeconds: number,
): LegacyPanelIdentity | null {
  if (!value) return null;

  try {
    const identity = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!isLegacyPanelIdentity(identity)) return null;
    if (
      identity.expiresAt <= nowSeconds ||
      identity.expiresAt > nowSeconds + MAX_IDENTITY_LIFETIME_SECONDS ||
      !sameOperation(identity.operation, expectedOperation)
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

function isLegacyPanelIdentity(value: unknown): value is LegacyPanelIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "operation", "actorId", "expiresAt", "nonce"])
  ) {
    return false;
  }
  return (
    value.version === 1 &&
    isNonEmptyString(value.actorId) &&
    Number.isInteger(value.expiresAt) &&
    typeof value.nonce === "string" &&
    NONCE.test(value.nonce) &&
    isControlPanelOperation(value.operation)
  );
}

function isControlPanelOperation(value: unknown): value is ControlPanelOperation {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.id === "apps_create") {
    return hasExactKeys(value, ["id", "orgId"]) && isNonEmptyString(value.orgId);
  }
  if (value.id === "flags_list" || value.id === "flags_create" || value.id === "flag_config_get") {
    return (
      hasExactKeys(value, ["id", "appId", "environmentId"]) &&
      isNonEmptyString(value.appId) &&
      isNonEmptyString(value.environmentId)
    );
  }
  return false;
}

function sameOperation(left: ControlPanelOperation, right: ControlPanelOperation): boolean {
  if (left.id !== right.id) return false;
  if (left.id === "apps_create" && right.id === "apps_create") return left.orgId === right.orgId;
  if (left.id === "apps_create" || right.id === "apps_create") return false;
  return left.appId === right.appId && left.environmentId === right.environmentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
