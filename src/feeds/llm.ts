import { CATEGORIES, CURATOR_CATEGORY_KEYS } from '../categories';
import { sleep } from '../utils/coerce';
import { ARTICLE_TYPES, type ArticleEnrichment } from './types';

// The curator: one OpenAI-compatible /chat/completions call per batch of
// stories, validated field by field before anything reaches D1. Recovered from
// the pre-Poche pipeline (deleted in dd341cb) and re-pointed at the AI-hardware
// desk; the strict validators are unchanged because they were paid for.
//
// The two numbers that gate every call are measured, and they have already been
// wrong once. A batch of 8 took ~27s on the previous provider's model, which is
// where the 60s floor came from. Swapping in mimo-v2.6-flash measured **25s for
// a single story and 130s for the production batch of 8**, so a 60s ceiling
// aborted every batch — and an aborted batch is indistinguishable from a broken
// model: each story burns one of its attempts and eventually leaves the queue
// uncurated for good. Raise these when the model changes, not after.
const REQUEST_TIMEOUT_MS = 150_000;
const TIMEOUT_BACKOFF_MS = 15_000;

/** Two attempts, not three. At the measured latency two timeouts already cost
 *  five minutes, and a third cannot fit in a 15-minute cron tick alongside the
 *  ingest that runs first. A batch that fails twice is retried by the *next*
 *  tick — the rows stay pending, which is a better retry than a longer one. */
const MAX_ATTEMPTS = 2;

/** Thrown when a call ran out of time rather than out of contract. The curator
 *  treats the two differently on purpose: a timeout means the model is slow, and
 *  answering the same stories one at a time costs the same per story while
 *  spending the whole tick, so it does not fan out. */
export class CuratorTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = 'CuratorTimeoutError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Field-by-field validation of one model result. Anything that fails here is
 *  treated as a failed call (and retried) rather than being coerced: a summary
 *  that is really the model's apology, or a category outside the registry, would
 *  otherwise be written to D1 as if a human had chosen it. */
export function parseEnrichment(v: unknown): ArticleEnrichment {
  if (!isObject(v)) throw new Error('invalid enrichment');
  const { isOnTopic, category, articleType, tags, summary, blurb, qualityScore } = v;
  if (typeof isOnTopic !== 'boolean') throw new Error('invalid isOnTopic');
  if (typeof category !== 'string' || category.length > 40) throw new Error('invalid category');
  if (category !== '' && !(CURATOR_CATEGORY_KEYS as readonly string[]).includes(category))
    throw new Error(`category outside the registry: ${category}`);
  if (
    typeof articleType !== 'string' ||
    !(ARTICLE_TYPES as readonly string[]).includes(articleType)
  )
    throw new Error('invalid articleType');
  if (
    !Array.isArray(tags) ||
    tags.length > 8 ||
    tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 60)
  )
    throw new Error('invalid tags');
  if (typeof summary !== 'string' || summary.length < 1 || summary.length > 280)
    throw new Error('invalid summary');
  if (typeof blurb !== 'string' || blurb.length < 1 || blurb.length > 700)
    throw new Error('invalid blurb');
  if (
    typeof qualityScore !== 'number' ||
    !Number.isInteger(qualityScore) ||
    qualityScore < 0 ||
    qualityScore > 100
  )
    throw new Error('invalid qualityScore');
  return v as unknown as ArticleEnrichment;
}

function parseBatch(v: unknown): ArticleEnrichment[] {
  if (!isObject(v) || !Array.isArray((v as Record<string, unknown>).results))
    throw new Error('invalid batch');
  const results = (v as { results: unknown[] }).results;
  return results.map(parseEnrichment);
}

// The prompt is derived from the registry, never restated: a category added to
// src/categories.ts reaches the model automatically, and one the registry cannot
// serve is rejected in parseEnrichment rather than stored as a NULL hub.
const CATEGORY_GLOSSARY = CURATOR_CATEGORY_KEYS.map(
  (key) => `${key} (${CATEGORIES[key]?.label ?? key})`,
).join('; ');

const JSON_FIELDS = [
  'Respond as a JSON object with exactly these fields:',
  '- isOnTopic: boolean — true only for AI-hardware stories',
  `- category: string — one of: ${CURATOR_CATEGORY_KEYS.join(', ')}, or ""`,
  `- articleType: string — one of: ${ARTICLE_TYPES.join(', ')}`,
  '- tags: string[] — up to 8 short lowercase-hyphen topic tags, preferring the controlled vocabulary; brand/product names allowed',
  // The lengths are hard limits, and they are enforced: a reply that breaks one
  // rejects the whole batch (the validator is not a truncator), which costs eight
  // per-story calls to recover. `mimo-v2.6-flash` was measured crossing the
  // summary limit occasionally, so the limit is spelled out as a consequence
  // rather than as a preference.
  '- summary: string — one factual sentence of at most 280 characters, counting the characters; a longer one is rejected and costs a retry',
  '- blurb: string — concise editorial summary of at most 700 characters',
  '- qualityScore: integer 0-100 — editorial quality of THIS story, not your confidence in labelling it',
].join('\n');

/** Preferred topic vocabulary. Not exhaustive — proper-noun entity tags are
 *  explicitly allowed on top — but it keeps the card's tag row readable instead
 *  of a cloud of one-off synonyms. */
const CONTROLLED_TAGS = [
  'gpu',
  'cpu',
  'npu',
  'accelerator',
  'inference',
  'training',
  'hbm',
  'dram',
  'nand',
  'ssd',
  'cxl',
  'interconnect',
  'pcie',
  'foundry',
  'process-node',
  'advanced-packaging',
  'server',
  'workstation',
  'ai-pc',
  'datacenter',
  'rack',
  'cooling',
  'liquid-cooling',
  'power',
  'networking',
  'edge',
  'driver',
  'benchmark',
  'roadmap',
  'pricing',
  'supply',
  'export-controls',
  'open-weights',
  'model-release',
  'quantization',
  'agents',
  'robotics',
  'deals',
  'leak',
] as const;

const CLASSIFIER_RULES = [
  'You are the editorial classification agent for an AI-hardware desk. It covers the silicon, systems and datacenter build-out behind AI, plus the models and tooling that decide what that hardware is for.',
  'isOnTopic=true for: AI accelerators, GPUs, NPUs and the silicon behind them (architecture, drivers, benchmarks, supply, pricing); CPUs, SoCs and the silicon process research behind them (process nodes, transistor and packaging research, foundries, wafers, the chip industry as a business); complete machines of every size — servers, workstations, AI PCs, laptops, mini PCs, edge devices — and the datacenter build-out around them (racks, power, cooling, networking, interconnects); memory and storage (HBM, DRAM, NAND, SSD, CXL) and the supply chain for it; displays and desk hardware (monitors, panels, keyboards, mice, docks, cases) when the story is about the product itself; AI models, research, and tooling when the story is about what runs them or how fast.',
  'Reject with isOnTopic=false and an empty category: consumer phones, tablets and wearables with no AI-hardware angle; games, consoles and esports; crypto and blockchain; cars and EVs; general software, app and web news; security incidents with no hardware substance; funding rounds, hiring and corporate drama that say nothing about hardware or models; pure science and space stories.',
  'A story you cannot file is not automatically off-beat — but a story with no hardware substance is. Judge these two separately, and when both are true, reject: a broad retail deals round-up, an energy tariff or utility marketing, a maker tutorial that is really about software, a price-history post. Rejecting costs the desk nothing; storing it with no category puts it on the board and in no hub.',
  'Use only facts present in the source text. Never invent specifications, prices, release dates, product names or benchmark numbers.',
  "summary is one plain factual sentence a reader could verify from the source. blurb is the desk's own two-or-three-sentence description; it is what the card shows, so write it for a reader who will not open the link, and do not repeat the headline verbatim.",
  'Rate qualityScore on editorial merit: a hands-on review with measured numbers, a first-party specification announcement, or well-sourced reporting from a named outlet is high. A single-source leak, a rumour aggregation, an affiliate deal post, or a story that is mostly speculation is low. A confidently-labelled leak is still a low-quality leak.',
  'File a story whenever one beat owns it, which is most of the time. A single product is owned: a mini PC, laptop, workstation or server is `systems`; a monitor, keyboard or mouse is `peripherals`; a CPU, SoC, process node or packaging story is `processors`; a GPU or accelerator story is `accelerators`; HBM, DRAM, NAND, SSD or CXL is `memory`; racks, power, cooling or datacenter networking is `datacenter`; a model, benchmark or training story is `models`.',
  'Leave category empty only for a story that genuinely spans beats: a full build list, a company result covering many product lines, a policy story that is not chip-specific, a roundup of unrelated items. Return tags either way — tags are how a cross-beat story stays findable.',
  'The canonical categories, in full:',
  `${CATEGORY_GLOSSARY}.`,
  `Tags: prefer the controlled vocabulary [${CONTROLLED_TAGS.join(', ')}]. You may add proper-noun entity tags (brand, product, company, e.g. "nvidia", "rtx-5090", "mi450", "tsmc", "hbm4"). Do not invent topical tags outside that list — pick the closest controlled tag instead. Never repeat the category as a tag.`,
  'Examples:',
  '- "NVIDIA lifts the lid on Rubin: 8 stacks of HBM4 and a 600W envelope" from the vendor → isOnTopic=true, category=accelerators, articleType=news, tags=[gpu, hbm, nvidia, roadmap], qualityScore~85.',
  '- "RTX 6080 pictured with 24GB, claims a forum poster" → isOnTopic=true, category=accelerators, articleType=leak, tags=[gpu, leak, nvidia], qualityScore~30.',
  '- "HBM4 pricing climbs as three suppliers sell out through 2027" → isOnTopic=true, category=memory, articleType=analysis, tags=[hbm, supply, pricing], qualityScore~80.',
  '- "Micron 9550 Pro 30TB SSD review: measured throughput and power draw" → isOnTopic=true, category=memory, articleType=review, tags=[ssd, nand, benchmark], qualityScore~85.',
  '- "Liquid cooling reaches the rack: what a 130kW deployment needs" → isOnTopic=true, category=datacenter, articleType=analysis, tags=[datacenter, liquid-cooling, power, rack], qualityScore~75.',
  '- "Hands on with a 64GB unified-memory mini workstation" → isOnTopic=true, category=systems, articleType=review, tags=[workstation, ai-pc, benchmark], qualityScore~70.',
  '- "Anthropic ships a coding-focused frontier model" → isOnTopic=true, category=models, articleType=news, tags=[model-release, agents], qualityScore~85.',
  '- "Geekom A5 mini PC review: Ryzen 7 in a 0.6L chassis, measured" → isOnTopic=true, category=systems, articleType=review, tags=[ai-pc, benchmark], qualityScore~70.',
  '- "ASUS ROG Strix XG32UQDS: 4K 180Hz with a third-generation QD-OLED panel" → isOnTopic=true, category=peripherals, articleType=news, tags=[oled, pricing], qualityScore~50.',
  '- "Advancing the CFET device roadmap: novel integration for 1nm-class logic" → isOnTopic=true, category=processors, articleType=analysis, tags=[process-node, advanced-packaging], qualityScore~75.',
  '- "Best Amazon Prime Day tech deals: live roundup" → isOnTopic=false, category="".',
  '- "A utility is selling a gaming-branded electricity tariff" → isOnTopic=false, category="".',
  '- "Elden Ring patch notes: PvP balance changes" → isOnTopic=false, category="".',
].join('\n');

/** The story as the model sees it. No publisher category: by the time the
 *  curator runs, the raw upstream category has already been discarded by
 *  `storeArticle` (unmapped values are not stored), so passing a default would
 *  be inventing one. Title, teaser text, host and source name are what is left,
 *  and they are enough — the classification is about the story, not the byline. */
function articleBlock(article: CuratorArticle): string[] {
  return [
    `Source: ${article.sourceName}`,
    `Title: ${article.title}`,
    `Text: ${article.description || '(none)'}`,
    `URL: ${article.url}`,
  ];
}

/** What the curator needs from a stored row. Deliberately not `RawArticle`:
 *  curation runs after storage, against D1, not against the feed. */
export interface CuratorArticle {
  id: string;
  sourceName: string;
  title: string;
  description: string;
  url: string;
}

/** Below this the model has nothing to judge and the tick would spend a call on
 *  a title alone; such a story keeps its pre-curation deck and leaves the queue
 *  as a `skipped` run. Measured feeds carry 95–1164 median characters, so this
 *  only fires on the genuinely empty ones. */
export const MIN_CURATOR_TEXT_CHARS = 40;

function promptFor(article: CuratorArticle): string {
  return [...CLASSIFIER_RULES, JSON_FIELDS, '', ...articleBlock(article)].join('\n');
}

function promptForBatch(articles: CuratorArticle[]): string {
  return [
    ...CLASSIFIER_RULES,
    `Classify and summarize each of the ${articles.length} stories below.`,
    `Return a JSON object {"results": [...]} holding exactly one object per story, in the same order.`,
    `Each object must have these fields:\n${JSON_FIELDS}`,
    'Judge each story only on its own text; do not let one influence another.',
    '',
    ...articles.flatMap((article, index) => [
      `--- STORY ${index + 1} ---`,
      ...articleBlock(article),
      '',
    ]),
  ].join('\n');
}

/** One OpenAI-compatible /chat/completions call. `baseUrl` is a var
 *  (LLM_BASE_URL) so the same code drives any compatible endpoint — this
 *  pipeline has already run on Gemini, z.ai GLM and a DeepSeek endpoint without
 *  the transport changing. response_format json_object plus the validators above
 *  are what guarantee a usable payload; the timeout floor is measured, not
 *  guessed (a reasoning model needed 27s for a batch of 8). */
async function requestLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  input: string,
  attempt: number,
): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: input }],
      response_format: { type: 'json_object' },
      // Explicit, because a provider default can be low enough to cut a batch
      // reply off mid-JSON — observed once on mimo at the production batch size.
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + attempt * TIMEOUT_BACKOFF_MS),
  });
}

/** MAX_ATTEMPTS attempts, backoff 500 × (attempt + 1). Both an HTTP error status
 *  and an unparseable payload retry; the last attempt's error propagates — as a
 *  `CuratorTimeoutError` when the attempt ran out of time, so the caller can tell
 *  a slow model from an incoherent one. */
async function callWithRetry<T>(
  request: (attempt: number) => Promise<Response>,
  parse: (text: string) => T,
  failLabel: string,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await request(attempt);
      if (response.ok) {
        const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        return parse(data.choices?.[0]?.message?.content ?? '');
      }
      throw new Error(`${failLabel} failed with ${response.status}`);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new CuratorTimeoutError(failLabel);
        }
        throw error;
      }
    }
    await sleep(500 * (attempt + 1));
  }
  throw new Error(`${failLabel} failed`);
}

export async function enrichWithLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  article: CuratorArticle,
): Promise<ArticleEnrichment> {
  if (!apiKey) throw new Error('LLM_API_KEY is not configured');
  return callWithRetry(
    (attempt) => requestLLM(apiKey, baseUrl, model, promptFor(article), attempt),
    (text) => parseEnrichment(JSON.parse(text) as unknown),
    'LLM request',
  );
}

/** One call for a whole batch. A response whose length does not match the input
 *  is rejected outright — the caller falls back to per-story calls, because a
 *  model that dropped one story must not shift every later enrichment onto the
 *  wrong article. */
export async function enrichBatchWithLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  articles: CuratorArticle[],
): Promise<ArticleEnrichment[]> {
  if (!apiKey) throw new Error('LLM_API_KEY is not configured');
  if (articles.length === 0) return [];
  return callWithRetry(
    (attempt) => requestLLM(apiKey, baseUrl, model, promptForBatch(articles), attempt),
    (text) => {
      const results = parseBatch(JSON.parse(text) as unknown);
      if (results.length !== articles.length) {
        throw new Error(`LLM returned ${results.length} results for ${articles.length} stories`);
      }
      return results;
    },
    'LLM batch request',
  );
}

/** Exported for the prompt-coverage test: the rules must name every curated
 *  category key, so a registry addition cannot silently go unclassified. */
export const __promptInternals = { CLASSIFIER_RULES, JSON_FIELDS, CONTROLLED_TAGS };
