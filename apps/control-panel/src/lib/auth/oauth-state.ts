import { safeReturnPath } from "#lib/auth/return-path";
import {
  clearHttpOnlyCookie,
  generateOpaqueToken,
  isOpaqueToken,
  nowSeconds,
  parseCookie,
  serializeHttpOnlyCookie,
  type SerializedHttpOnlyCookie,
  tokenHash,
} from "#lib/sessions/session-cookie";

export const OAUTH_STATE_COOKIE_NAME = "__session_state";

const OAUTH_STATE_KEY_PREFIX = "oauth_state:";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

interface OAuthState {
  returnTo: string;
  expiresAt: number;
}

export async function createOAuthState(
  kv: KVNamespace,
  returnTo: string,
  now = Date.now(),
): Promise<{ state: string; cookie: SerializedHttpOnlyCookie }> {
  const state = generateOpaqueToken();
  const expiresAt = nowSeconds(now) + OAUTH_STATE_TTL_SECONDS;
  const value: OAuthState = { returnTo, expiresAt };
  await kv.put(oauthStateKey(await tokenHash(state)), JSON.stringify(value), {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });

  return {
    state,
    cookie: oauthStateCookie(state),
  };
}

export async function consumeOAuthState(
  kv: KVNamespace,
  request: Request,
  callbackState: string | null,
  now = Date.now(),
): Promise<
  | { ok: true; returnTo: string; clearCookie: SerializedHttpOnlyCookie }
  | { ok: false; clearCookie: SerializedHttpOnlyCookie }
> {
  const clearStateCookie = clearHttpOnlyCookie(OAUTH_STATE_COOKIE_NAME);
  const cookieState = parseCookie(request.headers.get("cookie")).get(OAUTH_STATE_COOKIE_NAME);
  if (
    !callbackState ||
    !cookieState ||
    callbackState !== cookieState ||
    !isOpaqueToken(callbackState)
  ) {
    return { ok: false, clearCookie: clearStateCookie };
  }

  const key = oauthStateKey(await tokenHash(callbackState));
  const raw = await kv.get(key, "text");
  await kv.delete(key);
  if (!raw) {
    return { ok: false, clearCookie: clearStateCookie };
  }

  const parsed = parseOAuthState(raw, now);
  if (!parsed) {
    return { ok: false, clearCookie: clearStateCookie };
  }

  return {
    ok: true,
    returnTo: safeReturnPath(parsed.returnTo, request.url),
    clearCookie: clearStateCookie,
  };
}

function parseOAuthState(raw: string, now: number): OAuthState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { expiresAt, returnTo } = parsed as Partial<OAuthState>;
  if (
    typeof returnTo !== "string" ||
    returnTo.length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt)
  ) {
    return null;
  }
  if (expiresAt <= nowSeconds(now)) {
    return null;
  }
  return { returnTo, expiresAt };
}

function oauthStateKey(stateHash: string): string {
  return `${OAUTH_STATE_KEY_PREFIX}${stateHash}`;
}

function oauthStateCookie(state: string): SerializedHttpOnlyCookie {
  return serializeHttpOnlyCookie(OAUTH_STATE_COOKIE_NAME, state, {
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
}
