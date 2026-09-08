import {
  DEFAULT_CONTROL_PLANE_JSON_BODY_LIMIT,
  DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES,
  incomingJsonBoundVisited,
  PERSISTED_JSON_MAX_INCOMING_DEPTH,
  WriteClosedJsonSchemaSchema,
} from "@splitch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInput } from "./parse-input";

const closedJsonBodySchema = z.object({
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  body: WriteClosedJsonSchemaSchema,
});

const wideShallowBodySchema = z.object({
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
});

/** Queues this wide exhaust an isolate; incidental tiny helper arrays are ignored. */
const LARGE_QUEUE_MIN = 32;

let originalArrayPush: typeof Array.prototype.push | undefined;

afterEach(() => {
  restoreArrayPush();
});

describe("parseInput incoming JSON bound", () => {
  it("rejects a depth-2000 type:null properties chain with 400 and never throws", async () => {
    const parsed = await parseInput(
      closedJsonBodySchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify(nestClosedJsonProperties(2000, { type: "null" })),
      }),
      {},
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues[0]?.path[0]).toBe("body");
    expect(parsed.error.details.issues[0]?.message).toMatch(/incoming depth/);
  });

  it("walks a 250k-element body at the pre-auth seam without retaining a wide queue", async () => {
    const body = Array.from({ length: 250_000 }, () => 0);
    const payload = JSON.stringify(body);
    expect(payload.length).toBe(500_001);
    expect(payload.length).toBeLessThan(DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES);
    expect(incomingJsonBoundVisited(body)).toBe(250_001);

    const largePushes = await countLargeArrayPushes(async () => {
      const parsed = await parseInput(
        wideShallowBodySchema,
        new Request("http://worker.test/event-definitions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(new TextEncoder().encode(payload).byteLength),
          },
          body: payload,
        }),
        {},
        DEFAULT_CONTROL_PLANE_JSON_BODY_LIMIT,
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(Array.isArray(parsed.value.body)).toBe(true);
      expect((parsed.value.body as unknown[]).length).toBe(250_000);
    });
    expect(largePushes).toBeLessThan(body.length / 100);
  });

  it("finds a depth overflow after a wide shallow prefix", async () => {
    const body: unknown[] = Array.from({ length: 250_000 }, () => 0);
    body[249_999] = nestToIncomingOverflow();
    const parsed = await parseInput(
      wideShallowBodySchema,
      new Request("http://worker.test/event-definitions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      {},
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    if (parsed.error.code !== "VALIDATION_ERROR") return;
    expect(parsed.error.details.issues[0]?.message).toMatch(/incoming depth/);
  });
});

function nestToIncomingOverflow(): unknown {
  let node: unknown = "leaf";
  for (let depth = 1; depth <= PERSISTED_JSON_MAX_INCOMING_DEPTH; depth += 1) {
    node = { child: node };
  }
  return node;
}

function nestClosedJsonProperties(
  depth: number,
  leaf: Record<string, unknown>,
): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let index = 0; index < depth; index += 1) {
    node = { type: leaf.type, properties: { child: node } };
  }
  return node;
}

async function countLargeArrayPushes(run: () => Promise<void>): Promise<number> {
  const previousPush = Array.prototype.push;
  originalArrayPush = previousPush;
  let largePushes = 0;
  Array.prototype.push = function boundedArrayPush(this: unknown[], ...items: unknown[]) {
    if (this.length >= LARGE_QUEUE_MIN) {
      largePushes += 1;
    }
    return previousPush.apply(this, items);
  };
  try {
    await run();
    return largePushes;
  } finally {
    restoreArrayPush();
  }
}

function restoreArrayPush(): void {
  if (originalArrayPush !== undefined) {
    Array.prototype.push = originalArrayPush;
    originalArrayPush = undefined;
  }
}
