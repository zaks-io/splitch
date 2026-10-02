import { describe, expect, it } from "vitest";
import { deriveMcpProtocolTools, isMcpToolRoute } from "./mcp-tools";
import {
  createClosed,
  createIdempotentClosed,
  deleteClosed,
  mcpReversibilityMeta,
  mcpToolAnnotations,
  reversibilityClasses,
} from "./route-effects";
import { getRoute, routeRegistry } from "./route-registry";

describe("route effects: audited declarations", () => {
  it("declares effects on every registry route", () => {
    for (const route of routeRegistry) {
      expect(typeof route.effects.mutates).toBe("boolean");
      expect(typeof route.effects.destructive).toBe("boolean");
      expect(typeof route.effects.idempotent).toBe("boolean");
      expect(typeof route.effects.openWorld).toBe("boolean");
      expect(reversibilityClasses).toContain(route.effects.reversibility);
      if (!route.effects.mutates) {
        expect(route.effects.destructive).toBe(false);
      }
    }
  });

  it("does not treat GET as read-only: client_key_get provisions a credential", () => {
    const route = getRoute("client_key_get");
    expect(route?.method).toBe("GET");
    expect(route?.effects.mutates).toBe(true);
  });

  it("does not treat POST as mutating: results read and test-eval write nothing", () => {
    const results = getRoute("experiment_results_post");
    const testEval = getRoute("flags_test_eval");
    expect(results?.method).toBe("POST");
    expect(testEval?.method).toBe("POST");
    expect(results?.effects.mutates).toBe(false);
    expect(testEval?.effects.mutates).toBe(false);
  });

  it("leaves kill-switch-off as a reversible config write, not a gated class", () => {
    const route = getRoute("flag_config_update");
    expect(route?.effects.mutates).toBe(true);
    expect(route?.effects.reversibility).toBe("reversible");
    expect(route?.effects.destructive).toBe(false);
  });
});

describe("route effects: create idempotency audit", () => {
  it("marks segments_create non-idempotent: retries mint a fresh Segment id", () => {
    const route = getRoute("segments_create");
    expect(route?.effects).toEqual(createClosed);
    expect(route?.effects?.idempotent).toBe(false);
    expect(mcpToolAnnotations(createClosed).idempotentHint).toBe(false);
  });

  it("keeps createClosed non-idempotent and reserves createIdempotentClosed for proven replay", () => {
    expect(createClosed.idempotent).toBe(false);
    expect(createIdempotentClosed.idempotent).toBe(true);

    const nonIdempotentCreates = [
      "segments_create",
      "metrics_create",
      "experiments_create",
      "event_definitions_create",
      "apps_create",
      "environments_create",
      "organizations_create",
      "organization_members_add",
      "app_members_add",
      "convex_installations_create",
      "cloudflare_installations_create",
      "sentry_installations_create",
    ] as const;
    for (const operationId of nonIdempotentCreates) {
      const route = getRoute(operationId);
      expect(route?.effects.idempotent, operationId).toBe(false);
      expect(route?.effects.mutates, operationId).toBe(true);
    }

    const idempotentCreates = [
      "flags_create",
      "flag_variants_create",
      "flags_promote",
      "conclusion_promotion_requests_create",
      "entity_privacy_export",
    ] as const;
    for (const operationId of idempotentCreates) {
      const route = getRoute(operationId);
      expect(route?.effects).toEqual(createIdempotentClosed);
      expect(route?.idempotency, operationId).toBe("required");
    }
  });
});

describe("route effects: approval review advertises permanent deletion", () => {
  it("marks approval_request_reviews_create as destructive and irreversible", () => {
    const route = getRoute("approval_request_reviews_create");
    expect(route?.effects).toEqual(deleteClosed);
    expect(mcpToolAnnotations(deleteClosed)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(mcpReversibilityMeta(deleteClosed)).toEqual({
      reversibilityClass: "irreversible",
    });

    const tool = deriveMcpProtocolTools().find(
      (entry) => entry.name === "approval_request_reviews_create",
    );
    expect(tool?.annotations).toEqual(mcpToolAnnotations(deleteClosed));
    expect(tool?._meta).toEqual(mcpReversibilityMeta(deleteClosed));
  });
});

describe("route effects: privacy export intake mutates", () => {
  it("declares entity_privacy_export as a mutating, non-destructive intake", () => {
    const route = getRoute("entity_privacy_export");
    expect(route?.effects).toEqual(createIdempotentClosed);
    expect(route?.effects.mutates).toBe(true);
    expect(route?.effects.destructive).toBe(false);
    expect(mcpToolAnnotations(createIdempotentClosed).readOnlyHint).toBe(false);
  });

  it.each([
    "current_user_privacy_export",
    "organization_privacy_export",
    "app_privacy_export",
  ] as const)("declares %s as mutating privacy intake", (operationId) => {
    const route = getRoute(operationId);
    expect(route?.effects).toEqual(createClosed);
    expect(mcpToolAnnotations(createClosed).readOnlyHint).toBe(false);
  });
});

describe("route effects: mutating MCP tools", () => {
  it("gives every mutating MCP tool a reversibility class", () => {
    for (const route of routeRegistry.filter(isMcpToolRoute)) {
      if (!route.effects.mutates) continue;
      expect(reversibilityClasses).toContain(route.effects.reversibility);
    }
  });
});
