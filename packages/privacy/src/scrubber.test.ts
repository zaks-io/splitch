import { describe, expect, it } from "vitest";
import { REDACTED } from "./redaction-rules";
import { scrubValue } from "./scrubber";

describe("scrubValue", () => {
  it("redacts a whole `context` (Evaluation Context) subtree, keeping the key", () => {
    const out = scrubValue({
      appId: "app_1",
      context: { email: "u@example.com", plan: "pro", country: "US" },
    }) as Record<string, unknown>;
    expect("context" in out).toBe(true);
    expect(out.context).toBe(REDACTED);
    expect(out.appId).toBe("app_1");
  });

  it("redacts targeting and evaluationContext containers", () => {
    const out = scrubValue({
      targeting: { userId: "abc" },
      evaluationContext: { tier: "gold" },
    }) as Record<string, unknown>;
    expect(out.targeting).toBe(REDACTED);
    expect(out.evaluationContext).toBe(REDACTED);
  });

  it("redacts known PII leaf names at any depth, replacing the value not the key", () => {
    const out = scrubValue({
      level1: { level2: { email: "deep@example.com", phone: "555-0100", okay: 1 } },
    }) as { level1: { level2: { email: unknown; phone: unknown; okay: unknown } } };
    expect(out.level1.level2.email).toBe(REDACTED);
    expect(out.level1.level2.phone).toBe(REDACTED);
    expect(out.level1.level2.okay).toBe(1);
    expect("email" in out.level1.level2).toBe(true);
  });

  it("redacts the bare targetingKey at any level", () => {
    const out = scrubValue({ a: { b: { targetingKey: "user-123" } } }) as {
      a: { b: { targetingKey: unknown } };
    };
    expect(out.a.b.targetingKey).toBe(REDACTED);
  });

  it("redacts keyMaterial fields without hiding safe values", () => {
    const out = scrubValue({
      credential: {
        value: "control",
        keyMaterial: "pk_secret",
      },
    }) as { credential: { value: unknown; keyMaterial: unknown } };

    expect(out.credential.value).toBe("control");
    expect(out.credential.keyMaterial).toBe(REDACTED);
  });

  it("preserves __proto__ as an own scrubbed key without mutating the output prototype", () => {
    const input = JSON.parse('{"__proto__":{"email":"proto@example.com"}}') as Record<
      string,
      unknown
    >;
    const out = scrubValue(input) as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(out, "__proto__");

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(descriptor?.enumerable).toBe(true);
    expect((descriptor?.value as Record<string, unknown>).email).toBe(REDACTED);
    expect(JSON.stringify(out).includes("proto@example.com")).toBe(false);
  });

  it("recurses through arrays of objects", () => {
    const out = scrubValue({
      users: [{ email: "a@x.com" }, { email: "b@x.com", role: "admin" }],
    }) as { users: Array<Record<string, unknown>> };
    expect(out.users[0]?.email).toBe(REDACTED);
    expect(out.users[1]?.email).toBe(REDACTED);
    expect(out.users[1]?.role).toBe("admin");
  });

  it("scrubs PII embedded in a stringified-JSON value", () => {
    const payload = JSON.stringify({ context: { email: "leak@example.com" }, traceId: "t1" });
    const out = scrubValue({ raw: payload }) as { raw: string };
    expect(out.raw.includes("leak@example.com")).toBe(false);
    expect(out.raw.includes(REDACTED)).toBe(true);
    expect(out.raw.includes("t1")).toBe(true);
  });

  it("leaves non-JSON strings and safe scalars untouched", () => {
    const out = scrubValue({ note: "all good", count: 7, flag: true }) as Record<string, unknown>;
    expect(out.note).toBe("all good");
    expect(out.count).toBe(7);
    expect(out.flag).toBe(true);
  });

  it("does not infinite-loop on extreme nesting", () => {
    let deep: Record<string, unknown> = { email: "x@y.com" };
    for (let i = 0; i < 200; i++) deep = { nested: deep };
    expect(() => scrubValue(deep)).not.toThrow();
  });
});
