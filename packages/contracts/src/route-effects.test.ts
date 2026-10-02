import { describe, expect, it } from "vitest";
import { isMcpToolRoute } from "./mcp-tools";
import { getRoute, routeRegistry } from "./route-registry";
import { reversibilityClasses } from "./route-effects";

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

describe("route effects: mutating MCP tools", () => {
  it("gives every mutating MCP tool a reversibility class", () => {
    for (const route of routeRegistry.filter(isMcpToolRoute)) {
      if (!route.effects.mutates) continue;
      expect(reversibilityClasses).toContain(route.effects.reversibility);
    }
  });
});
