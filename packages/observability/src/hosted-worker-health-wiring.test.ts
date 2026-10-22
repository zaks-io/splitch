import { expect, it } from "vitest";
import { defaultExportIsWrapped } from "./hosted-worker-wrap-gate.js";

const prefix =
  'import { wrapWorkerHandler } from "@splitch/observability/worker"; const handler = { fetch() {} };';

it.each([
  'health: { paths: ["/health"], respond(env) { return Response.json(env); } }',
  'health: { paths: ["/", "/health"], async respond(env) { return Response.json(env); } }',
  'health: { paths: ["/health"], respond: healthResponse }',
  'health: { paths: ["/health"], respond: (env) => Response.json(env) }',
  'health: ({ paths: (["/health"] as const), respond: (healthResponse as HealthResponder) })',
])("accepts static health options %s", (health) => {
  expect(
    defaultExportIsWrapped(
      `${prefix} export default wrapWorkerHandler(handler, { surface: "fixture", ${health} });`,
    ),
  ).toBe(true);
});

it.each([
  "health: await healthOptions",
  'health: await { paths: ["/health"], respond: healthResponse }',
  "health: { paths: await healthPaths, respond: healthResponse }",
  'health: { paths: await ["/health"], respond: healthResponse }',
  'health: { paths: ["/health"], respond: await healthResponse }',
  'health: { paths: ["/health"], respond: ((await healthResponse) as HealthResponder) }',
  "health: mutateHandler()",
  "health: { ...mutateHandler() }",
  "health: { paths: mutateHandler(), respond: healthResponse }",
  "health: { paths: [mutateHandler()], respond: healthResponse }",
  'health: { paths: ["/health"], respond: mutateHandler() }',
  'health: { paths: ["/health"], get respond() { return mutateHandler(); } }',
])("rejects effectful health options %s", (health) => {
  expect(
    defaultExportIsWrapped(
      `${prefix} export default wrapWorkerHandler(handler, { surface: "fixture", ${health} });`,
    ),
  ).toBe(false);
});
