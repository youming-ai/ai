import { defineScheduled } from 'void';
import type { Env } from '../src/data/api';
import { scheduled } from '../worker/scheduled';

// Void installs a Worker's cron triggers from the job files in crons/, and
// only from them: `triggers` in a Cloudflare config is ignored, and a deploy
// with no jobs publishes an empty schedule — the first Void deploy did exactly
// that and the desk stopped ingesting. Void also replaces the Worker's own
// `scheduled` export with a dispatcher that calls this job.
//
// Both schedules are one job because one function already tells them apart by
// controller.cron: */15 ingests, 17 3 sweeps. The daily string is duplicated
// in PRUNE_CRON (src/feeds/retention.ts); retention.cron.test.ts holds the two
// together.
export const cron = ['*/15 * * * *', '17 3 * * *'];

export default defineScheduled((controller, env, ctx) =>
  scheduled(controller, env as unknown as Env, ctx),
);
