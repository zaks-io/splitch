import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Tinybird local validator", () => {
  it("runs Tinybird YAML tests when present", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const script = readFileSync(join(repoRoot, "scripts/check-tinybird-local.mjs"), "utf8");
    expect(script).toMatch(/file\.endsWith\("\.yaml"\)/);
  });

  it("fails loudly when raw_events loses its dedup key contract", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const tempRoot = mkdtempSync(join(tmpdir(), "splitch-tinybird-bad-"));

    try {
      cpSync(join(repoRoot, "tinybird.config.json"), join(tempRoot, "tinybird.config.json"));
      cpSync(join(repoRoot, "infra"), join(tempRoot, "infra"), { recursive: true });
      const datasourcePath = join(
        tempRoot,
        "infra",
        "tinybird",
        "datasources",
        "raw_events.datasource",
      );
      writeFileSync(
        datasourcePath,
        readFileSync(datasourcePath, "utf8").replace("# DEDUP_KEY=dedup_key", ""),
      );

      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "scripts/check-tinybird-local.mjs")],
        {
          cwd: tempRoot,
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DEDUP_KEY=dedup_key");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses one Event Ingest writer token for both raw datasources", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const datasourceDir = join(repoRoot, "infra", "tinybird", "datasources");

    for (const name of ["raw_events.datasource", "raw_evaluations.datasource"]) {
      expect(readFileSync(join(datasourceDir, name), "utf8")).toContain(
        "TOKEN raw_events_ingest APPEND",
      );
    }
  });
});
