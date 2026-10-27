import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Audit retention, old invites, dead MFA sessions (plan Step 3.6).
crons.daily("cleanup", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.daily, {});

// Online -> offline for devices past their deadline (plan 4.9 amended, A3).
// Reads only the devices that just went silent: an idle fleet costs one empty
// index read per run.
crons.interval("presence sweep", { minutes: 5 }, internal.presence.sweep, {});

export default crons;
