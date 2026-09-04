import { getRoute, type RouteContract } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  DELEGATED_IDENTITY_HEADER,
  type DelegatedIdentity,
  delegatedAuthResolver,
  delegatedIdentityFor,
  delegatedIdentityFrom,
  delegatedRequest,
  notDelegatedResponse,
} from "./delegation";
import type { Principal } from "./principal";

/**
 * Both ends of the delegation protocol, tested against real registry contracts:
 * a hand-written path template here would pass while the shipped route mounted a
 * different one.
 */
const results = route("experiment_results_post");
const usage = route("organization_usage_get");
const allowed = [results, usage];

const identity: DelegatedIdentity = {
  operation: "experiment_results_post",
  actorId: "user_1",
  authKind: "control-plane-token",
  scopes: [],
  orgId: null,
  appId: "app_1",
  environmentId: "env_1",
};
const params = { appId: "app_1", environmentId: "env_1", experimentId: "exp_1" };

describe("delegated request", () => {
  it("carries the identity, the substituted path, and the parsed body", async () => {
    const request = delegatedRequest(results, identity, {
      params,
      body: { runId: "run_7" },
      requestId: "req_1",
    });

    expect(new URL(request.url).pathname).toBe("/apps/app_1/envs/env_1/experiments/exp_1/results");
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ runId: "run_7" });
    expect(request.headers.get("x-request-id")).toBe("req_1");
    // No credential travels: the binding is the authenticity guarantee.
    expect(request.headers.get("authorization")).toBeNull();
    expect(delegatedIdentityFor(request, allowed)).toEqual(identity);
  });

  it("sends a GET route's selector as query and no body", () => {
    const get = route("experiment_results_get");
    const request = delegatedRequest(
      get,
      { ...identity, operation: get.id },
      {
        params,
        query: { runId: "run_7", missing: undefined },
      },
    );

    expect(new URL(request.url).search).toBe("?runId=run_7");
    expect(request.body).toBeNull();
  });

  it("refuses to build a path it has no value for", () => {
    expect(() => delegatedRequest(results, identity, { params: { appId: "app_1" } })).toThrow(
      /no value for ":environmentId"/,
    );
  });
});

describe("delegated identity check", () => {
  it("rejects an operation this Worker is not delegated", () => {
    const request = delegatedRequest(results, identity, { params, body: {} });

    expect(delegatedIdentityFor(request, [usage])).toBeNull();
  });

  it("rejects a path naming an App the surface Worker did not authorize", () => {
    const request = delegatedRequest(results, identity, {
      params: { ...params, appId: "app_other" },
      body: {},
    });

    expect(delegatedIdentityFor(request, allowed)).toBeNull();
  });

  it("rejects a path naming an Environment the surface Worker did not authorize", () => {
    const request = delegatedRequest(results, identity, {
      params: { ...params, environmentId: "env_other" },
      body: {},
    });

    expect(delegatedIdentityFor(request, allowed)).toBeNull();
  });

  it("rejects a mismatched method, an unrelated path, and a malformed header", () => {
    const request = delegatedRequest(results, identity, { params, body: {} });
    const header = request.headers.get(DELEGATED_IDENTITY_HEADER) ?? "";

    // `allowed`, not a list without this operation: passing one that omits it
    // returns null at the allowlist check and never reaches the method branch.
    expect(
      delegatedIdentityFor(
        new Request(request.url, { method: "GET", headers: request.headers }),
        allowed,
      ),
    ).toBeNull();
    expect(
      delegatedIdentityFor(
        new Request("https://delegated.splitch.internal/apps/app_1/flags", {
          method: "POST",
          headers: { [DELEGATED_IDENTITY_HEADER]: header },
        }),
        allowed,
      ),
    ).toBeNull();
    for (const malformed of ["{}", "not json", JSON.stringify({ ...identity, appId: 7 })]) {
      expect(
        delegatedIdentityFor(
          new Request(request.url, {
            method: "POST",
            headers: { [DELEGATED_IDENTITY_HEADER]: malformed },
          }),
          allowed,
        ),
      ).toBeNull();
    }
    expect(delegatedIdentityFor(new Request(request.url, { method: "POST" }), allowed)).toBeNull();
  });

  /**
   * This runs in a `WorkerEntrypoint.fetch` with no guard around it, so a throw
   * here does not become a 404 with a request id -- it escapes the service
   * binding and the surface Worker reports a 500 for a request it should simply
   * not have recognized.
   */
  it.each(["%E0%A4%A", "%"])(
    "returns null rather than throwing on the malformed escape %s",
    (bad) => {
      const request = delegatedRequest(results, identity, { params, body: {} });
      const malformed = new Request(
        `https://delegated.splitch.internal/apps/${bad}/envs/env_1/experiments/exp_1/results`,
        { method: "POST", headers: request.headers },
      );

      expect(() => delegatedIdentityFor(malformed, allowed)).not.toThrow();
      expect(delegatedIdentityFor(malformed, allowed)).toBeNull();
    },
  );
});

/**
 * The Control Plane returns the binding's response verbatim, so this IS the API
 * response. Bare text here would mean the one path that reports a surface-Worker
 * bug is also the one path with no code and no request id to correlate on.
 */
describe("response for a request the owner will not accept as delegated", () => {
  it("answers in the canonical envelope and keeps the caller's request id", async () => {
    const res = notDelegatedResponse(
      delegatedRequest(results, identity, { params, body: {}, requestId: "req_1" }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-request-id")).toBe("req_1");
    expect(await res.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("still carries a request id when the delegated request had none", () => {
    const res = notDelegatedResponse(delegatedRequest(results, identity, { params, body: {} }));

    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("identity minted from the authorized principal", () => {
  it("takes Org and App from the credential and the Environment from the path", () => {
    // The guard already forced principal.appId to equal the path's App; an
    // env-unbound control-plane token selects the Environment by path (ADR-0027).
    expect(delegatedIdentityFrom(results, principal({ appId: "app_1" }), params)).toEqual(identity);
    expect(delegatedIdentityFrom(usage, principal({ orgId: "org_1" }), { orgId: "org_1" })).toEqual(
      {
        operation: "organization_usage_get",
        actorId: "user_1",
        authKind: "control-plane-token",
        scopes: [],
        orgId: "org_1",
        appId: null,
        environmentId: null,
      },
    );
  });

  it("keeps an env-bound credential's own Environment over the path's", () => {
    expect(
      delegatedIdentityFrom(results, principal({ appId: "app_1", environmentId: "env_1" }), {
        ...params,
        environmentId: "env_other",
      }).environmentId,
    ).toBe("env_1");
  });

  // The path and the credential agree in production because the guard refused
  // every request where they did not. Minting from the path anyway would still
  // pass every test above, and would silently turn the receiver's cross-check
  // into a tautology: a surface-Worker authorization bug would forward as a
  // well-formed cross-tenant read. So mint against a path that disagrees, and
  // prove the receiver refuses the result.
  it("follows the credential, not the path, so a surface-Worker bug is caught downstream", () => {
    const minted = delegatedIdentityFrom(results, principal({ appId: "app_1" }), {
      ...params,
      appId: "app_other",
    });

    expect(minted.appId).toBe("app_1");
    expect(
      delegatedIdentityFor(
        delegatedRequest(results, minted, { params: { ...params, appId: "app_other" }, body: {} }),
        allowed,
      ),
    ).toBeNull();
  });
});

describe("delegated auth resolver", () => {
  it("mints a scope-bound control-plane principal with no auth door", async () => {
    const resolved = await delegatedAuthResolver(identity)(new Request("https://x.internal/"));

    expect(resolved).toEqual({
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: "user_1",
        scopes: [],
        orgId: null,
        appId: "app_1",
        environmentId: "env_1",
        authDoor: null,
      },
    });
  });
});

function route(operationId: string): RouteContract {
  const contract = getRoute(operationId);
  if (!contract) throw new Error(`delegation.test: no route "${operationId}"`);
  return contract;
}

function principal(scope: Partial<Principal>): Principal {
  return {
    kind: "control-plane-token",
    id: "user_1",
    scopes: [],
    orgId: null,
    appId: null,
    environmentId: null,
    authDoor: "device_flow",
    ...scope,
  };
}
