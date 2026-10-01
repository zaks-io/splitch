import type { CloudflareInstallationStatus } from "@splitch/sdk/control-plane";
import { cliSleep } from "./cloudflare-endpoint.js";
import { cloudflareUsage } from "./cloudflare-error.js";
import type { CliDeps, CliIo } from "./execute-types.js";

/**
 * The control plane keeps retrying a 404 push for 10 minutes after
 * registration, once a minute, while a dispatcher colo still caches the 404 of
 * a Worker deleted moments before. Two more minutes cover the last dispatcher
 * tick and its lease. The window is restated here rather than shared because
 * the CLI ships against the published SDK, not the control plane.
 */
const WAIT_MINUTES = 12;
const POLL_MS = 5_000;
const POLL_ATTEMPTS = (WAIT_MINUTES * 60_000) / POLL_MS;

type DeliveryError = CloudflareInstallationStatus["latestDeliveryError"];

export async function waitForApplied(
  readStatus: () => Promise<CloudflareInstallationStatus>,
  deps: CliDeps,
  io: CliIo,
): Promise<CloudflareInstallationStatus> {
  const sleep = cliSleep(deps);
  const report = progressReporter(io);
  for (let polls = 0; ; polls += 1) {
    const current = await readStatus();
    if (current.lastAppliedVersion === current.environmentVersion) return current;
    assertStillPending(current, polls);
    report(current);
    await sleep(POLL_MS);
  }
}

function assertStillPending(current: CloudflareInstallationStatus, polls: number): void {
  // An older version's terminal delivery stays counted; only nothing left pending is final.
  if (current.pendingCount === 0 && current.terminalCount > 0)
    throw cloudflareUsage(
      `Cloudflare configuration delivery entered a terminal state: ${describeDeliveryError(current.latestDeliveryError)}`,
    );
  // Registration creates the delivery, so nothing pending or terminal means it was suppressed.
  if (current.pendingCount === 0)
    throw cloudflareUsage(
      `The Cloudflare installation is ${current.status} with no delivery pending for Environment version ${current.environmentVersion}; run splitch cloudflare status`,
    );
  if (polls >= POLL_ATTEMPTS)
    throw cloudflareUsage(
      `Cloudflare Worker did not apply Environment version ${current.environmentVersion} within ${WAIT_MINUTES} minutes; ${current.pendingCount} delivery still pending, latest delivery error: ${describeDeliveryError(current.latestDeliveryError)}`,
    );
}

/**
 * Announces the wait once, then each delivery error the first time it is seen.
 * The error is installation-wide and can belong to an older version, so it is
 * reported alongside the pending push, never as its cause.
 */
function progressReporter(io: CliIo): (current: CloudflareInstallationStatus) => void {
  let announced = false;
  let reported = "";
  return (current) => {
    if (!announced)
      io.error(
        `Waiting up to ${WAIT_MINUTES} minutes for the Cloudflare Worker to apply Environment version ${current.environmentVersion}`,
      );
    announced = true;
    if (!current.latestDeliveryError) return;
    const latest = describeDeliveryError(current.latestDeliveryError);
    if (latest !== reported)
      io.error(`Configuration push still pending; latest delivery error: ${latest}`);
    reported = latest;
  };
}

function describeDeliveryError(error: DeliveryError): string {
  // A delivered older version clears the installation's error even while a newer one is terminal.
  if (!error) return "no delivery error is recorded; run splitch cloudflare status";
  const status = error.httpStatus === undefined ? "" : ` HTTP ${error.httpStatus}`;
  const cause = error.causeName === undefined ? "" : ` (${error.causeName})`;
  return `${error.kind} ${error.code}${status}${cause} at ${error.occurredAt}`;
}
