interface EntityMetricPrivacyCursor {
  appId: string;
  idType: string;
  entityFamilyHash: string;
  after: string;
}

export function encodeEntityMetricPrivacyCursor(cursor: EntityMetricPrivacyCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeEntityMetricPrivacyCursor(value: string): EntityMetricPrivacyCursor {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join("\0") !==
        ["after", "appId", "entityFamilyHash", "idType"].join("\0")
    ) {
      throw new Error("unexpected fields");
    }
    const { appId, idType, entityFamilyHash, after } = parsed;
    if (
      typeof appId !== "string" ||
      appId.length === 0 ||
      typeof idType !== "string" ||
      idType.length === 0 ||
      typeof entityFamilyHash !== "string" ||
      entityFamilyHash.length === 0 ||
      typeof after !== "string" ||
      after.length === 0
    ) {
      throw new Error("invalid fields");
    }
    return { appId, idType, entityFamilyHash, after };
  } catch {
    throw new Error("Event Ingest Entity privacy cursor is invalid");
  }
}
