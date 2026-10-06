/// <reference types="@cloudflare/workers-types" />

import { handle } from '@astrojs/cloudflare/handler';
import type { Env } from '../src/data/api';
import { curatePending } from '../src/feeds/curate';
import { ingestAllSources } from '../src/feeds/ingest';
import { PRUNE_CRON, pruneOldRecords } from '../src/feeds/retention';
import { mediaRequest } from '../src/media';

const entrypoint: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    // `/media/<id>` is resolved here, ahead of Astro: it is a binary relay, and
    // Astro only mounts the worker dispatcher at `/api/*`, so a media request
    // that reached it would match no route and 404 against ASSETS.
    const media = mediaRequest(request, new URL(request.url));
    if (media) return media;
    return handle(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Logged with which cron failed, then rethrown: a scheduled event that
    // rejects follows the platform's retry path, and swallowing it here would
    // report a successful invocation for a tick that never ran. Per-source and
    // per-article failures are already handled inside; this covers the setup
    // failure that would otherwise escape (a D1 error while ensuring sources,
    // most likely).
    try {
      await runScheduled(controller, env, ctx);
    } catch (error) {
      console.error(`[scheduled] ${controller.cron} failed:`, error);
      throw error;
    }
  },
};

/** Keep a log line readable when a whole vocabulary is unmapped.
 *
 *  The desk's own sources each publish their own categories — the first real
 *  tick measured 179/179 rows unregistered across 60+ distinct values ('gpus',
 *  'ai/ml/dl', 'nanosheets'…). The count is the signal; the names are only
 *  interesting at the head, and an unbounded list buries every other log line
 *  from the same tick. */
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
    // Info level now that the curator assigns the stored category from the story
    // text: a publisher category outside the registry is a taxonomy hint we
    // ignore, not a hole in the board. Kept because the values are still the
    // only early signal that an upstream feed changed shape.
    console.log(
      `[scheduled] ${report.uncategorized}/${report.fetched} stored rows carried an unregistered publisher category:`,
      nameList(report.unmappedCategories),
    );
  }

  // Curation runs after ingestion in the same tick so a new story reaches a hub
  // within one cron interval. Its failures are its own: a model outage leaves
  // the rows published-but-uncurated (the queue the health check reports) and
  // must not fail the tick that just collected them.
  const curation = await curatePending(env);
  if (!curation.configured) {
    console.warn(
      '[scheduled] LLM_API_KEY/LLM_BASE_URL/LLM_MODEL not configured: stored rows stay uncurated',
    );
  } else if (curation.selected > 0) {
    console.log(
      `[scheduled] curated ${curation.curated}, filtered ${curation.filtered}, skipped ${curation.skipped}, failed ${curation.failed} of ${curation.selected} selected`,
    );
  }
  if (curation.failed > 0) {
    console.error(`[scheduled] curator failed on ${curation.failed} stories`);
  }
}

export default entrypoint;
