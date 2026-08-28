import { describe, expect, it } from "vitest";
import { serializeSchema } from "./flag-definition-handler-utils";

describe("serializeSchema", () => {
  it("stringifies a finite Flag schema document", () => {
    expect(serializeSchema({ type: "number", maximum: 10 })).toBe('{"type":"number","maximum":10}');
    expect(serializeSchema(null)).toBeNull();
    expect(serializeSchema(undefined)).toBeNull();
  });

  it("refuses to persist a non-finite number as JSON null", () => {
    expect(() => serializeSchema({ maximum: Number.POSITIVE_INFINITY })).toThrow(
      "Flag schema contains a non-finite number",
    );
    expect(() => serializeSchema({ minimum: Number.NEGATIVE_INFINITY })).toThrow(
      "Flag schema contains a non-finite number",
    );
    expect(JSON.stringify({ maximum: Number.POSITIVE_INFINITY })).toBe('{"maximum":null}');
  });
});
