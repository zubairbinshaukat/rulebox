import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Audit retention, old invites, dead MFA sessions (plan Step 3.6).
crons.daily("cleanup", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.daily, {});

export default crons;
