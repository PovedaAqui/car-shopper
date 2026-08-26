import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

/**
 * Maintenance schedule: every 10 minutes, requeue stale claimed jobs and
 * expire jobs stuck in the queue for > 24h (see convex/maintenance.ts).
 */
const crons = cronJobs();

crons.interval(
  "car-shopper-maintenance",
  { minutes: 10 },
  api.maintenance.runMaintenance,
  {}
);

export default crons;
