import { rowObject, stringField } from "./results-row-fields";

export interface EntityPrivacyCursor {
  appId: string;
  idType: string;
  entityFamilyHash: string;
  store: string;
  recordId: string;
  serverReceivedAt: string;
  targetingKeyHash: string;
  recordHash: string;
}

const CURSOR_KEYS = [
  "appId",
  "entityFamilyHash",
  "idType",
  "recordHash",
  "recordId",
  "serverReceivedAt",
  "store",
  "targetingKeyHash",
] as const;

export function encodeEntityPrivacyCursor(cursor: EntityPrivacyCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeEntityPrivacyCursor(value: string): EntityPrivacyCursor {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = rowObject(JSON.parse(new TextDecoder().decode(bytes)));
    if (Object.keys(parsed).sort().join("\0") !== [...CURSOR_KEYS].sort().join("\0")) {
      throw new Error("unexpected fields");
    }
    return {
      appId: stringField(parsed, "appId"),
      idType: stringField(parsed, "idType"),
      entityFamilyHash: stringField(parsed, "entityFamilyHash"),
      store: stringField(parsed, "store"),
      recordId: stringField(parsed, "recordId"),
      serverReceivedAt: stringField(parsed, "serverReceivedAt"),
      targetingKeyHash: stringField(parsed, "targetingKeyHash"),
      recordHash: stringField(parsed, "recordHash"),
    };
  } catch {
    throw new Error("analysis-api: Entity privacy cursor is invalid");
  }
}
