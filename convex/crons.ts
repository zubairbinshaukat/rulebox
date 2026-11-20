import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Audit retention, old invites, expired sessions (plan Step 3.6).
crons.daily("cleanup", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.daily, {});

// Exact recount of every organization's counters (plan Step 17 item 9), one
// organization at a time, paged; writes only what differs.
crons.daily("reconcile counters", { hourUTC: 4, minuteUTC: 0 }, internal.stats.reconcileAll, {});

// Phase 5 (Step 10): yesterday's per-device security counters become one row per organization,
// and expired counter rows go (device days 14 d, organization days 90 d). One organization per
// step, paged and rescheduled; an organization without rows costs three empty ranges.
crons.daily("security rollup", { hourUTC: 1, minuteUTC: 0 }, internal.security.rollup, {});

// Online -> offline for devices past their deadline (plan 4.9 amended, A3).
// Reads only the devices that just went silent: an idle fleet costs one empty
// index read per run.
crons.interval("presence sweep", { minutes: 5 }, internal.presence.sweep, {});

// Phase 5 Step 16: rollout rings. Every 15 minutes, the rollouts in state `rolling` are checked for a halt or an automatic promotion
// (plan 4.14). Reads one empty `by_state_stage` range when nothing is rolling; each rolling group is evaluated in its own transaction.
crons.interval("rollout tick", { minutes: 15 }, internal.rollouts.tick, {});

// Phase 6 Step 12 (plan 4.5): the vendor feeds of Rulebox-managed apps. ONE hourly tick for the whole deployment; it claims at most
// 10 feeds that are due (each is checked about once a day) and reads one empty index range when none is. No device takes part.
crons.interval("feed tick", { hours: 1 }, internal.feeds.tick, {});

export default crons;
