import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "recover Splitch configuration sync",
  { minutes: 1 },
  internal.integration.recoverSync,
);
crons.interval(
  "recover Splitch Exposure delivery",
  { minutes: 1 },
  internal.evaluation.recoverDeliveries,
);
crons.interval("purge expired Splitch records", { hours: 1 }, internal.retention.purgeExpired);

export default crons;
