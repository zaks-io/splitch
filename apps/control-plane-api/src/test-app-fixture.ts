import type { Hono } from "hono";
import { type AppDeps, controlPlaneRegistrar, createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import type { FixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
import { AUDIENCE, allowLimiter, ISSUER, NOW_MS } from "./test-constants";
import type { TokenMembershipAccess } from "./token-membership";

type TestAppDeps = Partial<AppDeps> & Pick<AppDeps, "repo">;
type TokenAuth = {
  signer: FixtureSigner;
  sessions: KVNamespace;
  membershipAccess?: TokenMembershipAccess;
  now?: () => number;
};

type TestAppOptions = TestAppDeps & (Pick<AppDeps, "authResolver"> | TokenAuth);

export function makeTestApp(options: TestAppOptions): Hono {
  return createApp(testAppDeps(options));
}

export function makeTestRegistrar(options: TestAppOptions) {
  return controlPlaneRegistrar(testAppDeps(options));
}

function testAppDeps(options: TestAppDeps & Partial<TokenAuth>): AppDeps {
  const { signer, sessions, membershipAccess, now, ...deps } = options;
  let authResolver = deps.authResolver;
  if (!authResolver) {
    if (!signer || !sessions) throw new Error("test app requires a signer and session KV");
    authResolver = makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        issuer: ISSUER,
        fetchJwks: async () => signer.jwks,
        controlPlaneAudience: AUDIENCE,
      }),
      sessions: makeSessionStore(sessions),
      membershipAccess: membershipAccess ?? {
        authorize: async () => true,
        resolve: async () => {
          throw new Error("test app has no wide membership fixture");
        },
      },
      now: now ?? (() => NOW_MS),
    });
  }
  return { ...deps, authResolver, rateLimiter: deps.rateLimiter ?? allowLimiter };
}
