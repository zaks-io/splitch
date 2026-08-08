import { describe, expect, it } from "vitest";
import { type ControlPanelOperation, parseControlPanelOperation } from "./control-panel-operation";
import { type Route, OPERATION_ROUTES } from "./control-panel-operation-coverage-table";
import { isControlPanelOperation, sameOperation } from "./control-panel-operation-guards";

const COVERAGE = Object.entries(OPERATION_ROUTES) as Array<
  [string, { route: Route; operation: ControlPanelOperation }]
>;

function scopeKeys(operation: ControlPanelOperation): string[] {
  return Object.keys(operation).filter((key) => key !== "id");
}

describe("control-panel operation wiring", () => {
  it.each(COVERAGE)("%s has a parser that yields exactly its claim", (_id, {
    route,
    operation,
  }) => {
    expect(
      parseControlPanelOperation(route.method, route.pathname, route.environmentId, route.search),
    ).toEqual(operation);
  });

  it.each(COVERAGE)("%s has a predicate that accepts its claim", (_id, { operation }) => {
    expect(isControlPanelOperation(operation)).toBe(true);
  });

  it.each(COVERAGE)("%s rejects a claim with a smuggled extra field", (_id, { operation }) => {
    expect(isControlPanelOperation({ ...operation, smuggled: "x" })).toBe(false);
  });

  it.each(COVERAGE)("%s rejects a claim missing any scope field", (_id, { operation }) => {
    for (const key of scopeKeys(operation)) {
      const { [key]: _dropped, ...rest } = operation as Record<string, unknown>;
      expect(isControlPanelOperation(rest)).toBe(false);
    }
  });

  it.each(COVERAGE)("%s rejects a claim with a blank scope field", (_id, { operation }) => {
    for (const key of scopeKeys(operation)) {
      expect(isControlPanelOperation({ ...operation, [key]: "" })).toBe(false);
    }
  });

  /**
   * The bypass this pins: a delegation minted for one resource must never verify
   * against another. Every scope field has to participate in the comparison, not
   * just the ones a hand-written switch arm remembered.
   */
  it.each(COVERAGE)("%s discriminates on every scope field", (_id, { operation }) => {
    expect(sameOperation(operation, { ...operation })).toBe(true);
    for (const key of scopeKeys(operation)) {
      const other = { ...operation, [key]: "other_value" } as ControlPanelOperation;
      expect(sameOperation(operation, other)).toBe(false);
      expect(sameOperation(other, operation)).toBe(false);
    }
  });

  it("never treats two different operation ids as the same operation", () => {
    for (const [, left] of COVERAGE) {
      for (const [, right] of COVERAGE) {
        if (left.operation.id === right.operation.id) continue;
        expect(sameOperation(left.operation, right.operation)).toBe(false);
      }
    }
  });
});
