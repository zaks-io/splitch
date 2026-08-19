import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runReactConsumerSmoke(tarballPath) {
  const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-react-consumer-"));
  try {
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify(
        { name: "splitch-sdk-react-consumer", private: true, type: "module" },
        null,
        2,
      ),
    );
    execFileSync("npm", ["install", tarballPath, "react@19.2.8", "react-dom@19.2.8"], {
      cwd: consumerRoot,
      stdio: "inherit",
      env: { ...process.env, npm_config_cache: join(consumerRoot, ".npm-cache") },
    });
    writeFileSync(
      join(consumerRoot, "render.mjs"),
      `import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createSplitchBrowserClient } from "@splitch/sdk/browser";
import { SplitchProvider, useFlag } from "@splitch/sdk/react";

const client = createSplitchBrowserClient({
  clientKey: "pk_smoke",
  context: { targetingKey: "react-consumer" },
  bootstrap: {
    context: { targetingKey: "react-consumer", idType: "user", attributes: {} },
    evaluations: {
      checkout: {
        variant: true,
        variantName: "on",
        reason: "SPLIT",
        errorCode: null,
        exposureTicket: null,
        exposureIdentity: null,
      },
    },
    etag: '"react-smoke-1"',
  },
  revalidateMs: 0,
  document: null,
  window: null,
});

function Flag() {
  return createElement("span", null, String(useFlag("checkout", false)));
}

const html = renderToString(
  createElement(SplitchProvider, { client }, createElement(Flag)),
);
if (html !== "<span>true</span>") {
  throw new Error(\`React consumer rendered unexpected HTML: \${html}\`);
}
await client.close();
console.log("react consumer smoke passed");
`,
    );
    execFileSync("node", ["render.mjs"], { cwd: consumerRoot, stdio: "inherit" });
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}
