import { describe, expect, it } from "vitest";
import type { EnvironmentRow } from "./app-environment-model";
import { recordResolvedEnvironment, resolvedEnvironment } from "./resolved-environment";

const row: EnvironmentRow = {
  id: "env_resolved",
  appId: "app_resolved",
  key: "prod",
  name: "Production",
  policy: "{}",
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  createdBy: null,
};

describe("trusted resolved Environment", () => {
  it("carries the row only on the exact parsed input object", () => {
    const input = { params: { appId: row.appId, environmentId: row.id } };
    recordResolvedEnvironment(input, row);
    expect(resolvedEnvironment(input, row.appId, row.id)).toBe(row);
    expect(resolvedEnvironment({ ...input }, row.appId, row.id)).toBeUndefined();
  });

  it("distinguishes a proven miss from an unread input", () => {
    const input = {};
    recordResolvedEnvironment(input, null);
    expect(resolvedEnvironment(input, row.appId, row.id)).toBeNull();
    expect(resolvedEnvironment({}, row.appId, row.id)).toBeUndefined();
  });

  it("fails loudly when a carried row differs from the canonical scope", () => {
    const input = {};
    recordResolvedEnvironment(input, row);
    expect(() => resolvedEnvironment(input, "app_other", row.id)).toThrow(
      /canonical request scope/,
    );
    expect(() => resolvedEnvironment(input, row.appId, "env_other")).toThrow(
      /canonical request scope/,
    );
  });

  it("rejects non-object parsed input at recording time", () => {
    expect(() => recordResolvedEnvironment(undefined, row)).toThrow(/non-object parsed input/);
  });
});
