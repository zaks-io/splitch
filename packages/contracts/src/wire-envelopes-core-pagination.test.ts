import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LIST_READ_LIMIT,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PaginationQuerySchema,
  boundListRead,
  listResponse,
} from "./wire-envelopes-core";

const PageOfStrings = listResponse(z.string());

describe("listResponse factory", () => {
  it("parses a complete unpaginable page", () => {
    const page = PageOfStrings.parse({
      items: ["a", "b"],
      readLimit: LIST_READ_LIMIT,
      readTruncated: false,
      cursor: null,
    });
    expect(page.items).toEqual(["a", "b"]);
    expect(page.readLimit).toBe(LIST_READ_LIMIT);
    expect(page.readTruncated).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("parses cursor: null with readTruncated: true (more exists, no continuation)", () => {
    const page = PageOfStrings.parse({
      items: ["a"],
      readLimit: 1,
      readTruncated: true,
      cursor: null,
    });
    expect(page.readTruncated).toBe(true);
    expect(page.cursor).toBeNull();
  });

  it("parses a paginated page with a continuation cursor", () => {
    const page = PageOfStrings.parse({
      items: ["a"],
      readLimit: 50,
      readTruncated: false,
      cursor: "opaque-next",
    });
    expect(page.cursor).toBe("opaque-next");
    expect(page.readTruncated).toBe(false);
  });

  it("preserves the item schema's parsed type", () => {
    const PageOfObjects = listResponse(z.object({ id: z.string() }));
    const page = PageOfObjects.parse({
      items: [{ id: "x" }],
      readLimit: LIST_READ_LIMIT,
      readTruncated: false,
      cursor: null,
    });
    expect(page.items[0]?.id).toBe("x");
  });

  it("rejects an item that fails the item schema", () => {
    expect(
      PageOfStrings.safeParse({
        items: [1],
        readLimit: LIST_READ_LIMIT,
        readTruncated: false,
        cursor: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an omitted cursor (present-with-null, never absent)", () => {
    expect(
      PageOfStrings.safeParse({
        items: [],
        readLimit: LIST_READ_LIMIT,
        readTruncated: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing readTruncated (never inferred)", () => {
    expect(
      PageOfStrings.safeParse({
        items: [],
        readLimit: LIST_READ_LIMIT,
        cursor: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing readLimit", () => {
    expect(PageOfStrings.safeParse({ items: [], readTruncated: false, cursor: null }).success).toBe(
      false,
    );
  });

  it("rejects a readLimit above LIST_READ_LIMIT", () => {
    expect(
      PageOfStrings.safeParse({
        items: [],
        readLimit: LIST_READ_LIMIT + 1,
        readTruncated: false,
        cursor: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive readLimit", () => {
    expect(
      PageOfStrings.safeParse({
        items: [],
        readLimit: 0,
        readTruncated: false,
        cursor: null,
      }).success,
    ).toBe(false);
  });

  it("rejects the deleted total field as an extra if the helper is strict about known keys", () => {
    const parsed = PageOfStrings.parse({
      items: [],
      readLimit: LIST_READ_LIMIT,
      readTruncated: false,
      cursor: null,
      total: 0,
    });
    expect(parsed).not.toHaveProperty("total");
  });
});

describe("boundListRead", () => {
  it("observes truncation at limit+1 and never infers it from a full page", () => {
    expect(boundListRead(["a", "b"], 2)).toEqual({
      items: ["a", "b"],
      readLimit: 2,
      readTruncated: false,
      cursor: null,
    });
    expect(boundListRead(["a", "b", "c"], 2)).toEqual({
      items: ["a", "b"],
      readLimit: 2,
      readTruncated: true,
      cursor: null,
    });
  });

  it("defaults the cap to LIST_READ_LIMIT", () => {
    const scanned = Array.from({ length: LIST_READ_LIMIT + 1 }, (_, i) => i);
    const page = boundListRead(scanned);
    expect(page.readLimit).toBe(LIST_READ_LIMIT);
    expect(page.readTruncated).toBe(true);
    expect(page.items).toHaveLength(LIST_READ_LIMIT);
    expect(page.cursor).toBeNull();
  });

  it("refuses a readLimit above LIST_READ_LIMIT", () => {
    expect(() => boundListRead(["a"], LIST_READ_LIMIT + 1)).toThrow(/1\.\.200/);
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

  it("coerces a URL query-string limit", () => {
    const q = PaginationQuerySchema.parse({ limit: "50" });
    expect(q.limit).toBe(50);
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
