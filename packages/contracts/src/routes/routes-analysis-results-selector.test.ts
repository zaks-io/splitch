import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveMcpProtocolTools } from "../mcp-tools";
import {
  OptionalResultsSelectorSchema,
  ResultsSelectorQuerySchema,
  ResultsSelectorSchema,
} from "./routes-analysis-results-selector";

describe("ResultsSelectorQuerySchema (GET wire)", () => {
  it("parses includeExploratory from true/false query strings", () => {
    expect(
      ResultsSelectorQuerySchema.parse({ view: "concise", includeExploratory: "true" }),
    ).toEqual({ view: "concise", includeExploratory: true });
    expect(
      ResultsSelectorQuerySchema.parse({ view: "concise", includeExploratory: "false" }),
    ).toEqual({ view: "concise", includeExploratory: false });
  });

  it("rejects non-boolean query strings for includeExploratory", () => {
    expect(ResultsSelectorQuerySchema.safeParse({ includeExploratory: "1" }).success).toBe(false);
    expect(ResultsSelectorQuerySchema.safeParse({ includeExploratory: "yes" }).success).toBe(false);
  });

  it("accepts real booleans (Hono may coerce after preprocess in some paths)", () => {
    expect(ResultsSelectorQuerySchema.parse({ includeExploratory: true })).toEqual({
      includeExploratory: true,
    });
  });
});

describe("ResultsSelectorSchema (POST / MCP body)", () => {
  it("keeps includeExploratory as a real boolean and rejects strings", () => {
    expect(ResultsSelectorSchema.parse({ includeExploratory: true })).toEqual({
      includeExploratory: true,
    });
    expect(ResultsSelectorSchema.safeParse({ includeExploratory: "true" }).success).toBe(false);
    expect(OptionalResultsSelectorSchema.parse({ includeExploratory: false })).toEqual({
      includeExploratory: false,
    });
  });

  it("advertises boolean includeExploratory on the MCP-derived GET/POST tools", () => {
    const tools = deriveMcpProtocolTools();
    const getTool = tools.find((tool) => tool.name === "experiment_results_get");
    const postTool = tools.find((tool) => tool.name === "experiment_results_post");
    expect(getTool).toBeDefined();
    expect(postTool).toBeDefined();

    const getSchema = z.toJSONSchema(ResultsSelectorQuerySchema) as {
      properties?: Record<string, { type?: string }>;
    };
    const postSchema = z.toJSONSchema(ResultsSelectorSchema) as {
      properties?: Record<string, { type?: string }>;
    };
    expect(getSchema.properties?.includeExploratory?.type).toBe("boolean");
    expect(postSchema.properties?.includeExploratory?.type).toBe("boolean");
  });
});
