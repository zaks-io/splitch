import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PaginationQuerySchema,
  paginatedResponse,
} from "./wire-envelopes-core";

const PageOfStrings = paginatedResponse(z.string());

describe("paginatedResponse factory", () => {
  it("parses a page with total as a number (D1-backed list)", () => {
    const page = PageOfStrings.parse({
      items: ["a", "b"],
      cursor: "opaque-next",
      limit: 50,
      total: 2,
    });
    expect(page.items).toEqual(["a", "b"]);
    expect(page.cursor).toBe("opaque-next");
    expect(page.total).toBe(2);
  });

  it("parses a page with total: null (Tinybird-backed list)", () => {
    const page = PageOfStrings.parse({
      items: ["a"],
      cursor: null,
      limit: 50,
      total: null,
    });
    expect(page.total).toBeNull();
    expect(page.cursor).toBeNull();
  });

  it("preserves the item schema's parsed type", () => {
    const PageOfObjects = paginatedResponse(z.object({ id: z.string() }));
    const page = PageOfObjects.parse({
      items: [{ id: "x" }],
      cursor: null,
      limit: 50,
      total: 1,
    });
    expect(page.items[0]?.id).toBe("x");
  });

  it("rejects an item that fails the item schema", () => {
    expect(PageOfStrings.safeParse({ items: [1], cursor: null, limit: 50, total: 0 }).success).toBe(
      false,
    );
  });

  it("rejects an omitted cursor (present-with-null, never absent)", () => {
    expect(PageOfStrings.safeParse({ items: [], limit: 50, total: 0 }).success).toBe(false);
  });

  it("rejects an omitted total (present-with-null, never absent)", () => {
    expect(PageOfStrings.safeParse({ items: [], cursor: null, limit: 50 }).success).toBe(false);
  });

  it("rejects a negative total", () => {
    expect(PageOfStrings.safeParse({ items: [], cursor: null, limit: 50, total: -1 }).success).toBe(
      false,
    );
  });
});

describe("PaginationQuerySchema", () => {
  it("defaults limit to 50 and cursor to null when omitted", () => {
    const q = PaginationQuerySchema.parse({});
    expect(q.limit).toBe(PAGINATION_DEFAULT_LIMIT);
    expect(q.cursor).toBeNull();
  });

  it("accepts the cap limit of 500", () => {
    const q = PaginationQuerySchema.parse({ limit: PAGINATION_MAX_LIMIT });
    expect(q.limit).toBe(500);
  });

  it("rejects limit > 500 at the schema level (fail loud, not clamped)", () => {
    expect(PaginationQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
  });

  it("rejects limit < 1", () => {
    expect(PaginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    expect(PaginationQuerySchema.safeParse({ limit: 12.5 }).success).toBe(false);
  });
});
