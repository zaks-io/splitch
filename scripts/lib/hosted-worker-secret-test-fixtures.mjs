import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_DELEGATION_PAIRS } from "./hosted-worker-secrets.mjs";

export function delegationFixture({
  controlPlaneSecret = "MCP_CONTROL_PLANE_DELEGATION_SECRET",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "splitch-delegation-contract-"));
  writeWorker(
    root,
    "mcp-server",
    MCP_DELEGATION_PAIRS.map(({ name }) => name),
  );
  writeWorker(root, "control-plane-api", controlPlaneSecret ? [controlPlaneSecret] : []);
  writeWorker(root, "evaluation-api", ["MCP_EVALUATION_DELEGATION_SECRET"]);
  writeWorker(root, "analysis-api", ["MCP_ANALYSIS_DELEGATION_SECRET"]);
  writeIngestDatasources(root, ["raw_events", "raw_evaluations"]);
  return root;
}

/**
 * The probe reads which Data Sources the ingest token appends to out of the
 * Tinybird project, so the fixture ships the same declaration the real
 * `.datasource` files carry. `deduped_exposures` is written by a Pipe, not by the
 * token, and must stay out of the probe.
 */
export function writeIngestDatasources(root, names) {
  const dir = join(root, "infra", "tinybird", "datasources");
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, `${name}.datasource`), "TOKEN raw_events_ingest APPEND\n");
  }
  writeFileSync(join(dir, "deduped_exposures.datasource"), "TOKEN analysis_read READ\n");
}

/**
 * The read probe derives which Pipes to exercise from `TYPE ENDPOINT`, the same
 * declaration the real `.pipe` files carry. The Copy Pipe stays out of the
 * probe: it is run with TINYBIRD_COPY_TOKEN, not read with the read token.
 */
export function writeEndpointPipes(root, names) {
  const dir = join(root, "infra", "tinybird", "pipes");
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, `${name}.pipe`), "NODE usage\nSQL >\n    SELECT 1\n\nTYPE ENDPOINT\n");
  }
  writeFileSync(
    join(dir, "cp_deduped_exposures.pipe"),
    "NODE copy\nSQL >\n    SELECT 1\n\nTYPE COPY\n",
  );
}

export function delegationValues() {
  return Object.fromEntries(
    MCP_DELEGATION_PAIRS.map(({ name }, index) => [name, `delegation-${index}`]),
  );
}

export function writeWorker(root, name, required, vars) {
  const appDir = join(root, "apps", name);
  mkdirSync(appDir, { recursive: true });
  const env = { secrets: { required }, ...(vars ? { vars } : {}) };
  writeFileSync(
    join(appDir, "wrangler.jsonc"),
    JSON.stringify({ env: { "shared-preview": env, production: env } }),
  );
}
