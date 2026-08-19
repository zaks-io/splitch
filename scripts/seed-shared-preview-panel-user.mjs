#!/usr/bin/env node
/**
 * Provisions the AuthKit account the Control Panel hosted smoke logs in as, grants it
 * owner access to the seeded smoke Organization and App, and publishes the credentials
 * to the running job. The password never leaves the job: it is masked in the log stream
 * and written only to $GITHUB_ENV.
 */
import { appendFileSync } from "node:fs";
import { executeSharedPreviewSql } from "./lib/shared-preview-d1.mjs";
import { ensurePanelSmokeUser } from "./lib/shared-preview-panel-user.mjs";
import { buildPanelUserSql } from "./seed-shared-preview-smoke-sql.mjs";

const user = await ensurePanelSmokeUser({ apiKey: process.env.WORKOS_API_KEY });

const status = executeSharedPreviewSql(buildPanelUserSql(new Date().toISOString(), user.userId));
if (status !== 0) {
  console.error("seed-shared-preview-panel-user: granting smoke Organization access failed");
  process.exit(status);
}

publish({
  SPLITCH_SMOKE_PANEL_EMAIL: user.email,
  SPLITCH_SMOKE_PANEL_PASSWORD: user.password,
  SPLITCH_SMOKE_PANEL_USER_ID: user.userId,
});

console.log(
  `seed-shared-preview-panel-user: AuthKit smoke login ready for ${user.email} (${user.userId})`,
);

function publish(values) {
  // Mask first: any later step that echoes the value gets ***, and GITHUB_ENV is not logged.
  console.log(`::add-mask::${values.SPLITCH_SMOKE_PANEL_PASSWORD}`);
  const target = process.env.GITHUB_ENV;
  if (!target) {
    throw new Error(
      "GITHUB_ENV is not set; the panel smoke credentials have nowhere to go. " +
        "Run this script from the shared-preview deploy workflow.",
    );
  }
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`);
  appendFileSync(target, `${lines.join("\n")}\n`);
}
