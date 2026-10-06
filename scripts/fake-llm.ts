// A stand-in for the curator's OpenAI-compatible endpoint, so the whole
// pipeline can be exercised locally without spending model credit:
//
//   bun scripts/fake-llm.ts 8899 &
//   bunx wrangler dev --config dist/server/wrangler.json --port 8787 --local \
//     --test-scheduled --var LLM_BASE_URL:http://127.0.0.1:8899/v1 \
//     --var LLM_MODEL:fake --var LLM_API_KEY:test-key
//   curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"
//
// It answers both prompt shapes the client sends — `{"results":[...]}` for a
// batch, a bare object for a single story — and derives its answer from the
// story text so the desk's storage path is exercised end to end: real feeds in,
// real prompt, plausible enrichment out. Every call is logged with the story
// count and titles, which is how you check what the model was actually asked.
//
// It is deliberately NOT a classifier worth trusting: categories come from a
// keyword table, quality scores from a hash. Use it to prove the *pipeline*
// works, then point LLM_BASE_URL at the real endpoint to judge the model.
import { createServer } from 'node:http';
import { CURATOR_CATEGORY_KEYS } from '../src/categories';

const port = Number(process.argv[2] ?? 8899);

/** First match wins, so the order is the priority order. */
const CATEGORY_HINTS: [RegExp, string][] = [
  [/\b(hbm|dram|ddr\d|nand|ssd|nvme|memory|storage|cxl)\b/i, 'memory'],
  [
    /\b(gpu|geforce|radeon|rtx|accelerator|npu|tpu|h100|h200|b200|gb300|mi\d{3})\b/i,
    'accelerators',
  ],
  [
    /\b(cpu|ryzen|epyc|xeon|threadripper|snapdragon|soc|process-?node|transistor|packaging)\b/i,
    'processors',
  ],
  [/\b(server|rack|workstation|mini pc|ai pc|laptop|cluster|edge device)\b/i, 'systems'],
  [
    /\b(datacenter|data center|cooling|liquid cool|immersion|megawatt|power supply|substation)\b/i,
    'datacenter',
  ],
  [/\b(monitor|display|oled|ips|keyboard|mouse|dock|panel|desk)\b/i, 'peripherals'],
  [/\b(model|llm|gemini|gpt|claude|llama|qwen|deepseek|agent|benchmark|training)\b/i, 'models'],
];

const OFF_BEAT =
  /\b(elden ring|patch notes|esports|playstation|xbox|nintendo|crypto|bitcoin|electric vehicle|movie|tv show|recipe|weather)\b/i;

const TAG_HINTS: [RegExp, string][] = [
  [/\bhbm\b/i, 'hbm'],
  [/\bdram|ddr\d\b/i, 'dram'],
  [/\bssd|nvme|nand\b/i, 'ssd'],
  [/\bgpu|rtx|radeon|geforce\b/i, 'gpu'],
  [/\bcpu|ryzen|epyc|xeon\b/i, 'cpu'],
  [/\bdatacenter|data center\b/i, 'datacenter'],
  [/\bcooling|liquid\b/i, 'liquid-cooling'],
  [/\bpower|watt|kw\b/i, 'power'],
  [/\bnvidia\b/i, 'nvidia'],
  [/\bamd\b/i, 'amd'],
  [/\bintel\b/i, 'intel'],
  [/\btsmc\b/i, 'tsmc'],
  [/\bmodel|llm\b/i, 'model-release'],
  [/\bleak|rumou?r|pictured\b/i, 'leak'],
  [/\bdeal|price|pricing|slash/i, 'pricing'],
];

function enrichmentFor(title: string, text: string): unknown {
  const haystack = `${title} ${text}`;
  const onTopic = !OFF_BEAT.test(haystack);
  const category = onTopic
    ? (CATEGORY_HINTS.find(([pattern]) => pattern.test(haystack))?.[1] ?? '')
    : '';
  const tags = TAG_HINTS.filter(([pattern]) => pattern.test(haystack))
    .map(([, tag]) => tag)
    .filter((tag) => tag !== category)
    .slice(0, 6);
  const summary = `${text.split(/(?<=\.)\s/)[0] ?? title}`.slice(0, 280) || title.slice(0, 280);
  return {
    isOnTopic: onTopic,
    category,
    articleType: /\breview\b/i.test(haystack)
      ? 'review'
      : /\bleak|rumou?r|pictured\b/i.test(haystack)
        ? 'leak'
        : /\bdeal|slash/i.test(haystack)
          ? 'deal'
          : 'news',
    tags,
    summary,
    blurb: `${summary} (curated locally by scripts/fake-llm.ts)`.slice(0, 700),
    // Deterministic, spread over the range so the board's signal meter varies.
    qualityScore: 40 + ([...title].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 56),
  };
}

/** Pull the stories out of whichever prompt shape arrived. */
function storiesFromPrompt(prompt: string): { title: string; text: string }[] {
  const blocks = prompt.split(/--- STORY \d+ ---/).slice(1);
  const bodies = blocks.length > 0 ? blocks : [prompt];
  return bodies.map((block) => ({
    title: /^Title: (.*)$/m.exec(block)?.[1] ?? 'Untitled',
    text: /^Text: ([\s\S]*?)$/m.exec(block)?.[1] ?? '',
  }));
}

let call = 0;

// node:http rather than `Bun.serve`: this repo has no bun type definitions, and
// `scripts/**` is inside the program `astro check` walks — a Bun global there
// fails the build's typecheck gate. node:http is what the other probes use too.
createServer((request, response) => {
  if (!(request.url ?? '').endsWith('/chat/completions')) {
    response.writeHead(404).end('not found');
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: { content?: string }[];
    };
    const prompt = body.messages?.[0]?.content ?? '';
    const stories = storiesFromPrompt(prompt);
    const batched = prompt.includes('--- STORY ');
    call += 1;
    console.log(
      `[fake-llm] call ${call}: ${stories.length} story/stories (${batched ? 'batch' : 'single'}), ` +
        `${prompt.length} prompt chars -> ${stories.map((s) => s.title.slice(0, 40)).join(' | ')}`,
    );

    const results = stories.map((story) => enrichmentFor(story.title, story.text));
    const content = batched ? JSON.stringify({ results }) : JSON.stringify(results[0]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(port, () => {
  // Reported so a reader of the log can tell the stand-in apart from the real
  // endpoint, and can see which categories it is allowed to assign.
  console.log(
    `[fake-llm] listening on http://127.0.0.1:${port}/v1 — categories: ${CURATOR_CATEGORY_KEYS.join(', ')}`,
  );
});
