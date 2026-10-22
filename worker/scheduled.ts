import type { Env } from '../src/data/api';
import { ingestAllSources } from '../src/feeds/ingest';
import { PRUNE_CRON, pruneOldRecords } from '../src/feeds/retention';

/** The Worker's scheduled work: an ingest tick every 15 minutes, the retention
 *  sweep daily at PRUNE_CRON, told apart by `controller.cron`.
 *
 *  Its own module, free of the Astro handler, because two callers need it: the
 *  Void cron job in crons/desk.ts, which is what production runs, and the
 *  entrypoint's `scheduled` export for local `wrangler dev --test-scheduled`.
 *
 *  Logged with which cron failed, then rethrown: a scheduled event that rejects
 *  follows the platform's retry path, and swallowing it here would report a
 *  successful invocation for a tick that never ran. Per-source and per-article
 *  failures are already handled inside; this covers the setup failure that
 *  would otherwise escape (a D1 error while ensuring sources, most likely). */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  try {
    await runScheduled(controller, env, ctx);
  } catch (error) {
    console.error(`[scheduled] ${controller.cron} failed:`, error);
    throw error;
  }
}

/** Keep a log line readable when a whole vocabulary is unmapped.
 *
 *  The count is the signal; the names are only interesting at the head, and an
 *  unbounded list buries every other log line from the same tick. */
function nameList(values: string[], limit = 8): string {
  if (values.length <= limit) return values.join(', ');
  return `${values.slice(0, limit).join(', ')} … (${values.length - limit} more)`;
}

/** The loop body, split out so the handler can report a failure instead of
 *  letting it escape into a silent missed tick. */
async function runScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === PRUNE_CRON) {
    await pruneOldRecords(env);
    return;
  }

  const report = await ingestAllSources(env, ctx);
  // Surfacing failed sources at error level so observability can alert. A
  // source can fail every tick for a day without anything else noticing.
  if (report.failed.length > 0) {
    console.error(
      `[scheduled] ${report.failed.length}/${report.sources} sources failed:`,
      report.failed.join(', '),
    );
  }
  if (report.trimmed > 0) {
    // Info, not a warning: the freshness window and the per-source cap are
    // expected to trim — a publisher that switches to a full-archive feed shows
    // up here as a jump, which is the point of reporting it at all.
    console.log(
      `[scheduled] trimmed ${report.trimmed}/${report.fetched + report.trimmed} parsed items to the ${report.sources}-source window and cap`,
    );
  }
  if (report.uncategorized > 0) {
    // A Poche category outside the registry reaches the global board but no
    // hub; the names say which registry entry is missing.
    console.log(
      `[scheduled] ${report.uncategorized}/${report.fetched} stored rows carried an unregistered publisher category:`,
      nameList(report.unmappedCategories),
    );
  }
}
