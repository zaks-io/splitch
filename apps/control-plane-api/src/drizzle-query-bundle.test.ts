import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("preserves DrizzleQueryError constructor identity in the Wrangler bundle", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "spl-764-drizzle-bundle-"));
  try {
    try {
      await promisify(execFile)(
        "pnpm",
        ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          timeout: 45_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    } catch {
      // Wrangler output can describe bindings; do not attach it to test failures.
      throw new Error("Control Plane Wrangler dry-run did not complete successfully");
    }
    const bundle = await readFile(join(outdir, "index.js"), "utf8");
    const classDefinition = bundle.match(/^var DrizzleQueryError = class[\s\S]+?^};/m)?.[0];
    expect(classDefinition).toBeDefined();
    // Execute the emitted class and its emitted name helpers, rather than infer
    // runtime identity from a variable name that minification could preserve.
    const helpers = ["__defProp", "__name"].map((name) => {
      const definition = bundle.match(new RegExp(`^var ${name} = .+;$`, "m"))?.[0];
      expect(definition).toBeDefined();
      return definition;
    });
    const constructorName = runInNewContext(
      [
        ...helpers,
        classDefinition,
        'new DrizzleQueryError("select ?", [], undefined).constructor.name',
      ].join("\n"),
    );
    expect(constructorName).toBe("DrizzleQueryError");
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}, 60_000);
