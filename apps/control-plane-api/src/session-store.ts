/**
 * Session-validation hot read (access-control-matrix.md "Revocation").
 *
 * Killing a WorkOS session or revoking a control-plane token must take effect
 * before the token's own `exp`. The control-plane keeps a KV revocation marker
 * keyed by the token's session id; a present marker means the session was
 * revoked. Verifying signature/exp alone is not enough — a still-unexpired token
 * for a revoked session must be rejected.
 *
 * Fail-loud: a present marker → revoked (reject). Absent (`null`) → still valid.
 * A KV binding that THROWS is a genuine fault that propagates (the guard maps it
 * to 500); it is never swallowed into a silent allow.
 */

const REVOKED_PREFIX = "revoked:";
const PANEL_SESSION_PREFIX = "session:";

interface PanelSessionActor {
  userId: string;
}

export interface SessionStore {
  /** True iff the session/token was revoked. Throws on a KV fault (never silent). */
  isRevoked(sessionId: string): Promise<boolean>;
}

export interface PanelSessionStore {
  /** Redeem the predecessor Panel's SHA-256 session handle during the bounded bridge only. */
  loadPanelSessionActor(tokenHash: string, nowSeconds: number): Promise<PanelSessionActor | null>;
}

export function makeSessionStore(kv: KVNamespace): SessionStore {
  return {
    async isRevoked(sessionId) {
      const marker = await kv.get(`${REVOKED_PREFIX}${sessionId}`);
      return marker !== null;
    },
  };
}

/** Construct only for the self-expiring predecessor binding entrypoint. */
export function makePanelSessionStore(kv: KVNamespace): PanelSessionStore {
  return {
    async loadPanelSessionActor(tokenHash, nowSeconds) {
      if (!/^[a-f0-9]{64}$/u.test(tokenHash)) return null;
      const raw = await kv.get(`${PANEL_SESSION_PREFIX}${tokenHash}`, "text");
      return raw ? parsePanelSessionActor(raw, nowSeconds) : null;
    },
  };
}

/** Build a revocation key for writers/tests (single authoring point for the shape). */
export function revocationKey(sessionId: string): string {
  return `${REVOKED_PREFIX}${sessionId}`;
}

function parsePanelSessionActor(raw: string, nowSeconds: number): PanelSessionActor | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("userId" in value) ||
      !("expiresAt" in value) ||
      typeof value.userId !== "string" ||
      value.userId.length === 0 ||
      typeof value.expiresAt !== "number" ||
      !Number.isInteger(value.expiresAt) ||
      value.expiresAt <= nowSeconds
    ) {
      return null;
    }
    return { userId: value.userId };
  } catch {
    return null;
  }
}
