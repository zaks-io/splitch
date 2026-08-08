import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";

/**
 * Render a Zod schema the same way `buildOpenApiDocument` does: through an
 * emit-only OpenAPIHono route. Used by OpenAPI document pins that compare a
 * live subtree against the shape derived from a leaf schema.
 */
export function renderOpenApiSchema(schema: z.ZodTypeAny): object {
  const app = new OpenAPIHono();
  app.openapi(
    createRoute({
      method: "get",
      path: "/__openapi_schema_probe",
      responses: {
        200: {
          description: "schema probe",
          content: { "application/json": { schema } },
        },
      },
    }),
    () => {
      throw new Error("openapi-schema-probe: emit-only");
    },
  );
  const doc = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "schema-probe", version: "0" },
  });
  const rendered =
    doc.paths?.["/__openapi_schema_probe"]?.get?.responses?.["200"]?.content?.["application/json"]
      ?.schema;
  if (rendered === undefined || typeof rendered !== "object" || rendered === null) {
    throw new Error("openapi-schema-probe: failed to render schema");
  }
  return rendered;
}
