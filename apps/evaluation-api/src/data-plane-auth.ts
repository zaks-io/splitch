import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  CredentialCacheKVSchema,
  CredentialCacheKVSchemaV1,
  type ErrorResponse,
  kvEnvelope,
} from "@splitch/contracts";
import type { AuthResolver, AuthResult, Principal } from "@splitch/worker-runtime";

interface CredentialReader {
  get(key: string): Promise<string | null>;
}

const credentialEnvelope = kvEnvelope(CredentialCacheKVSchema);
const legacyCredentialEnvelope = kvEnvelope(CredentialCacheKVSchemaV1);

export function makeDataPlaneAuthResolver(credentialStore: CredentialReader): AuthResolver {
  return async (request) => {
    const credential = bearerCredential(request);
    if (credential === null) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }

    const hash = await sha256Hex(credential);
    const cached = await readCredentialByMaterial(credentialStore, credential, hash);
    if (cached === null) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }

    const failure = credentialFailure(request, cached);
    if (failure !== null) return failure;

    return {
      ok: true,
      principal: principalFromCredential(hash, cached),
    };
  };
}

export function makeApiKeyOnlyAuthResolver(dataPlaneAuthResolver: AuthResolver): AuthResolver {
  return async (request) => {
    const result = await dataPlaneAuthResolver(request);
    if (!result.ok) return result;
    if (result.principal.kind === "api-key") return result;

    return {
      ok: false,
      reason: "UNAUTHORIZED",
      error: {
        code: "INSUFFICIENT_SCOPES",
        message: "API Key required for this route",
        details: {
          requiredScopes: ["data-plane:evaluate"],
          heldScopes: [...result.principal.scopes],
        },
      },
    };
  };
}

export function makeClientKeyOnlyAuthResolver(dataPlaneAuthResolver: AuthResolver): AuthResolver {
  return async (request) => {
    const result = await dataPlaneAuthResolver(request);
    if (!result.ok) return result;
    if (result.principal.kind === "client-key") return result;

    return { ok: false, reason: "UNAUTHORIZED" };
  };
}

function credentialFailure(request: Request, cached: CredentialCache): AuthResult | null {
  if (cached.revoked) {
    return { ok: false, reason: "CREDENTIAL_REVOKED" };
  }
  if (cached.kind !== "client_key") {
    return null;
  }

  const origin = allowedOrigin(request, cached.originAllowlist ?? null);
  return origin.ok
    ? null
    : { ok: false, reason: "UNAUTHORIZED", error: originNotAllowed(origin.origin) };
}

async function readCredentialByMaterial(
  credentialStore: CredentialReader,
  credential: string,
  hash: string,
): Promise<CredentialCache | null> {
  if (credential.startsWith("sk_") || credential.startsWith("ak_")) {
    return readCredential(credentialStore, apiKeyCacheKey(hash));
  }
  if (credential.startsWith("pk_") || credential.startsWith("ck_")) {
    return readCredential(credentialStore, clientKeyCacheKey(hash));
  }
  return (
    (await readCredential(credentialStore, clientKeyCacheKey(hash))) ??
    (await readCredential(credentialStore, apiKeyCacheKey(hash)))
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerCredential(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const [scheme, credential] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !credential) return null;
  return credential;
}

function allowedOrigin(
  request: Request,
  allowlist: readonly string[] | null,
): { ok: true } | { ok: false; origin: string } {
  if (allowlist === null) {
    return { ok: true };
  }

  const origin = requestOrigin(request);
  if (origin === null) {
    return { ok: false, origin: "unknown" };
  }

  const allowed = new Set(allowlist.map((value) => normalizeOrigin(value) ?? value));
  return allowed.has(origin) ? { ok: true } : { ok: false, origin };
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return normalizeOrigin(origin) ?? origin;
  }

  const referer = request.headers.get("referer");
  if (referer !== null) {
    return normalizeOrigin(referer) ?? referer;
  }

  return null;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function originNotAllowed(origin: string): ErrorResponse {
  return {
    code: "ORIGIN_NOT_ALLOWED",
    message: "origin is not allowed for this Client Key",
    details: {
      origin,
      hint: "add this origin to the Client Key allow-list or open the key",
    },
  };
}

async function readCredential(
  credentialStore: CredentialReader,
  key: string,
): Promise<CredentialCache | null> {
  const raw = await credentialStore.get(key);
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error("evaluation-api: malformed credential cache blob", { cause });
  }

  const parsed = credentialEnvelope.safeParse(json);
  if (parsed.success) return { ...parsed.data.data, legacy: false };

  const legacy = legacyCredentialEnvelope.safeParse(json);
  if (legacy.success) {
    return { ...legacy.data.data, organizationId: null, legacy: true };
  }
  throw new Error(`evaluation-api: invalid credential cache blob: ${parsed.error.message}`);
}

type CredentialCache =
  | ((typeof CredentialCacheKVSchema)["_output"] & { legacy: false })
  | ((typeof CredentialCacheKVSchemaV1)["_output"] & {
      organizationId: null;
      legacy: true;
    });

function principalFromCredential(hash: string, credential: CredentialCache): Principal {
  return {
    kind: credential.kind === "client_key" ? "client-key" : "api-key",
    id: `${credential.kind}:${hash.slice(0, 16)}`,
    scopes: credential.scopes,
    orgId: credential.organizationId,
    appId: credential.appId,
    environmentId: credential.environmentId,
    // Client Keys and API Keys are not minted by an auth door; they are never
    // provisional, so this is null rather than a stand-in value.
    authDoor: null,
  };
}
