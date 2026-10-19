import { CATEGORIES, CURATOR_CATEGORY_KEYS } from '../categories';
import { CurationBudget, MODEL_MAX_TOKENS } from './curationPolicy';

export { CuratorTimeoutError, MIN_CURATOR_TEXT_CHARS } from './curationPolicy';

import { ARTICLE_TYPES, type ArticleEnrichment } from './types';

// The curator: one OpenAI-compatible /chat/completions call per batch of
// stories, validated field by field before anything reaches D1. Recovered from
// the pre-Poche pipeline (deleted in dd341cb). The editorial scope now favours
// useful discoveries; the transport and strict payload validators stay shared.
//
// Execution caps, deadlines and retries live in curationPolicy, not the prompt.

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
  '- isOnTopic: boolean — true only when the link is in scope AND worth recommending',
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
  'developer-tools',
  'open-source',
  'local-first',
  'productivity',
  'creative-tools',
  'code-assistant',
  'web',
  'frontend',
  'backend',
  'database',
  'architecture',
  'testing',
  'accessibility',
  'typography',
  'interaction',
  'animation',
  'design-systems',
  'visual-design',
  'data-visualization',
  'performance',
  'privacy',
  'security',
  'browser',
  'workflow',
  'research',
  'blockchain',
  'wallets',
  'smart-contracts',
  'decentralized-storage',
  'digital-identity',
  'zero-knowledge',
  'writing',
  'learning',
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
  'You are the editor of a discovery desk for builders, designers and curious readers. Recommend links a thoughtful colleague would save or share: useful tools, distinctive design, software craft, substantive AI advances and ideas worth reading. This is a collection of discoveries, not a comprehensive breaking-news wire.',
  'Set isOnTopic=true only when BOTH conditions hold: the subject fits the desk, and the supplied text gives a concrete reason to use, learn from, build with or appreciate it. Popularity, a famous publisher, a fashionable AI label and a recent timestamp are not reasons by themselves. Apply the same standard to an independent maker and an established company.',
  'Welcome: usable products and open-source projects with a clear capability or workflow; thoughtful interface, visual and industrial design, portfolios and case studies with identifiable craft; practical engineering explanations, tools and experiments; original essays with a specific argument; first-party AI model releases, research and demonstrations with a meaningful capability; substantial social posts, interviews and videos that contain these things.',
  'Hardware remains a supporting beat: accept meaningful computing advances, enabling devices, hands-on experiments and well-explained architecture. Reject routine spec bumps, product colour changes, generic buying guides, repetitive component leaks, pricing-only updates and affiliate deals round-up posts.',
  'Reject with isOnTopic=false and category="": thin launch copy that never explains what the product does; an AI wrapper with no stated distinct capability; sponsored pitches with no useful substance; SEO listicles; coupons; engagement bait; a reaction without an explanation or artifact; recycled announcements; fundraising, hiring or corporate drama without a substantive product or technical contribution; general politics, celebrity, sports, game updates and crypto speculation.',
  'Judge only facts present in the supplied source text. Do not invent product features, usability, visual quality, popularity, prices, specifications or benchmark results, and do not imply that you opened a site, tried a tool or verified a claim. A short teaser can establish a concrete capability, but a title or slogan alone is not evidence of quality.',
  'summary is one factual sentence that identifies the thing or central idea. blurb is two or three concise sentences explaining what it does or argues, what is distinctive in the source, and who could find it useful. Avoid hype and do not repeat the headline. If the source gives no concrete reason to recommend the link, reject it instead of filling the gap with generic praise.',
  'Rate qualityScore on the usefulness and substance of THIS link: originality, specificity, practical value, thoughtful craft, reproducible explanations and clear evidence. A small independent project can score highly. First-party marketing, source authority, recency and a confidently labelled category do not automatically earn a high score. Do not give a high score to a link you rejected.',
  'File each accepted link by its primary value: a usable app or product is `tools`; interface craft, visual work, portfolios and design case studies are `design`; code, libraries, engineering techniques and implementation guides are `development`; an original essay or analysis is `articles`; a substantial post whose value is the discussion or observation is `social`; a video, interview or podcast is `media`; AI models, model evaluations and model research are `models`. A product using AI is still `tools`, not automatically `models`. Prefer these content categories over the publisher identity.',
  'For a link specifically about hardware: a mini PC, laptop, workstation or server is `systems`; a monitor, keyboard or mouse is `peripherals`; a CPU, SoC, process node or packaging story is `processors`; a GPU or accelerator is `accelerators`; memory and storage are `memory`; racks, cooling and datacenter networking are `datacenter`. A hands-on coding project involving a device may still belong in `development`.',
  'Web3 is an active beat: useful wallets and dApps, blockchain protocols, smart-contract tools, decentralized storage, digital identity, zero-knowledge research and substantive technical or design explanations. Use category `crypto` (displayed as Web3) when that is the primary subject. Apply the same concrete-value standard as every other beat; reject price predictions, token pumps, airdrop spam and investment hype rather than rejecting Web3 as a whole.',
  'Use `other` for an accepted discovery without a more specific home. Leave category empty for rejected links.',
  'The canonical categories, in full:',
  `${CATEGORY_GLOSSARY}.`,
  `Tags: prefer the controlled vocabulary [${CONTROLLED_TAGS.join(', ')}]. You may add proper-noun entity tags (brand, product, company). Do not invent topical tags outside that list — pick the closest controlled tag instead. Never repeat the category as a tag.`,
  'Examples:',
  '- "An open-source notebook with local storage, offline search and portable Markdown export" → isOnTopic=true, category=tools, articleType=news, tags=[open-source, local-first, productivity], qualityScore~80 when those capabilities are explained in the text.',
  '- "How a small team designed an accessible command palette, with interaction examples" → isOnTopic=true, category=design, articleType=analysis, tags=[interaction, accessibility], qualityScore~85.',
  '- "A reproducible guide to diagnosing Postgres latency, including queries and measurements" → isOnTopic=true, category=development, articleType=guide, tags=[database, performance], qualityScore~85.',
  '- "An essay explaining why local-first software changes collaboration and data ownership" → isOnTopic=true, category=articles, articleType=analysis, tags=[local-first, privacy], qualityScore~80.',
  '- "An original interactive typography experiment with an explanation of its construction" → isOnTopic=true, category=design, articleType=analysis, tags=[typography, interaction], qualityScore~80.',
  '- "Anthropic releases a model with documented coding improvements and evaluation methods" → isOnTopic=true, category=models, articleType=news, tags=[model-release, code-assistant], qualityScore~80.',
  '- "A video walkthrough implementing a useful local AI workflow" → isOnTopic=true, category=media, articleType=video, tags=[workflow, inference], qualityScore~75.',
  '- "NVIDIA documents a new accelerator architecture with measured inference improvements" → isOnTopic=true, category=accelerators, articleType=analysis, tags=[gpu, inference, nvidia], qualityScore~80.',
  '- "The ultimate AI platform. Transform your life. Sign up today." → isOnTopic=false, category="", qualityScore~10: no stated capability.',
  '- "An open-source wallet demonstrating safer transaction previews with a documented interaction walkthrough" → isOnTopic=true, category=crypto (Web3), articleType=analysis, tags=[wallets, interaction, open-source], qualityScore~80.',
  '- "A reproducible guide to testing smart contracts with local tooling" → isOnTopic=true, category=crypto (Web3), articleType=guide, tags=[smart-contracts, testing], qualityScore~80.',
  '- "This token will 100x next week; buy before the pump" → isOnTopic=false, category="", qualityScore~5.',
  '- "Best Amazon Prime Day tech deals: live roundup" → isOnTopic=false, category="", qualityScore~15.',
  '- "Another RTX card appears with a slightly higher factory clock" → isOnTopic=false, category="", qualityScore~20.',
  '- "A startup raises $50 million; no product or technical details are provided" → isOnTopic=false, category="", qualityScore~15.',
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
  signal: AbortSignal,
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
      max_tokens: MODEL_MAX_TOKENS,
    }),
    signal,
  });
}

/** Keep transport, body consumption and validation inside the same attempt. */
async function callWithRetry<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  parse: (text: string) => T,
  failLabel: string,
  budget: CurationBudget,
): Promise<T> {
  return budget.run(async (signal) => {
    const response = await request(signal);
    if (!response.ok) throw new Error(`${failLabel} failed with ${response.status}`);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return parse(data.choices?.[0]?.message?.content ?? '');
  }, failLabel);
}

export async function enrichWithLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  article: CuratorArticle,
  budget = new CurationBudget(),
): Promise<ArticleEnrichment> {
  if (!apiKey) throw new Error('LLM_API_KEY is not configured');
  return callWithRetry(
    (signal) => requestLLM(apiKey, baseUrl, model, promptFor(article), signal),
    (text) => parseEnrichment(JSON.parse(text) as unknown),
    'LLM request',
    budget,
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
  budget = new CurationBudget(),
): Promise<ArticleEnrichment[]> {
  if (!apiKey) throw new Error('LLM_API_KEY is not configured');
  if (articles.length === 0) return [];
  return callWithRetry(
    (signal) => requestLLM(apiKey, baseUrl, model, promptForBatch(articles), signal),
    (text) => {
      const results = parseBatch(JSON.parse(text) as unknown);
      if (results.length !== articles.length) {
        throw new Error(`LLM returned ${results.length} results for ${articles.length} stories`);
      }
      return results;
    },
    'LLM batch request',
    budget,
  );
}

/** Exported for the prompt-coverage test: the rules must name every curated
 *  category key, so a registry addition cannot silently go unclassified. */
export const __promptInternals = { CLASSIFIER_RULES, JSON_FIELDS, CONTROLLED_TAGS };
