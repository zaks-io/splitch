import { describe, expect, it } from "vitest";
import type { InferRequestType, InferResponseType } from "hono/client";
import { hc } from "hono/client";
import { controlPlaneRpcApp, type ControlPlaneRpcApp } from "./openapi-rpc";
import { routeRegistry } from "./route-registry";

/**
 * Compile-time proof that `ControlPlaneRpcApp` is a real Hono RPC App type derived
 * from the route registry. Runtime checks only assert the emit-only app exists;
 * the `@ts-expect-error` lines are enforced by `tsc`.
 */

type RpcClient = ReturnType<typeof hc<ControlPlaneRpcApp>>;

function _validGetRouteIsTyped(): void {
  const client = hc<ControlPlaneRpcApp>("https://cp.example.test");
  type FlagsListRequest = InferRequestType<RpcClient["apps"][":appId"]["flags"]["$get"]>;
  type FlagsListResponse = InferResponseType<RpcClient["apps"][":appId"]["flags"]["$get"]>;
  const _param: FlagsListRequest["param"] = { appId: "app_123" };
  const _output: FlagsListResponse = {
    items: [],
    readLimit: 200,
    readTruncated: false,
    cursor: null,
  };
  void _param;
  void _output;
  void client.apps[":appId"].flags.$get;
}

function _validMutatingRouteIsTyped(): void {
  const client = hc<ControlPlaneRpcApp>("https://cp.example.test");
  type OrgPatchRequest = InferRequestType<RpcClient["orgs"][":orgId"]["$patch"]>;
  const _param: OrgPatchRequest["param"] = { orgId: "org_123" };
  void _param;
  void client.orgs[":orgId"].$patch;
}

function _invalidRouteIsRejected(): void {
  type FlagsListRequest = InferRequestType<RpcClient["apps"][":appId"]["flags"]["$get"]>;
  // @ts-expect-error — appId is a string path param, not a number.
  const _bad: FlagsListRequest["param"] = { appId: 123 };
  void _bad;
}

describe("control plane rpc app", () => {
  it("derives one emit-only app from every registered route", () => {
    expect(routeRegistry.length).toBeGreaterThan(0);
    expect(controlPlaneRpcApp).toBeDefined();
  });

  it("the compile-time hc proofs are present", () => {
    expect(typeof _validGetRouteIsTyped).toBe("function");
    expect(typeof _validMutatingRouteIsTyped).toBe("function");
    expect(typeof _invalidRouteIsRejected).toBe("function");
  });
});
