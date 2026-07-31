import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const expectedVerifyCi =
  "turbo run //#knip //#format:check //#spec:lint //#check:cli-mcp-parity //#test:scripts lint typecheck test test:connect-snippet stats:golden stats:property build";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);

describe("root stats gate wiring", () => {
  const rootPackageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
    scripts: Record<string, string>;
  };

  it("keeps verify:ci on the asserted stats gate string", () => {
    expect(rootPackageJson.scripts["verify:ci"]).toBe(expectedVerifyCi);
  });

  it("exposes root stats and spec lint scripts used by verify:ci", () => {
    expect(rootPackageJson.scripts["spec:lint"]).toBe("node scripts/spec-lint.mjs");
    expect(rootPackageJson.scripts["stats:golden"]).toBe("turbo run stats:golden");
    expect(rootPackageJson.scripts["stats:property"]).toBe("turbo run stats:property");
    expect(rootPackageJson.scripts["stats:simulation"]).toBe("turbo run stats:simulation");
  });
});
