// The board is rendered to strings: no component framework on the server, and
// none in the browser. This file is the whole template layer, and the security
// boundary React used to be. Titles, decks, domains, tags and image URLs come
// from feeds and the cursor comes from the request, so every value
// interpolated into `html` is escaped; only markup that `html` itself produced
// passes through as it is.

/** Markup that is safe to emit as it is. Only `html` and `attr` make one: the
 *  class is not exported, so nothing outside this module can wrap a string
 *  from a feed and have it pass through unescaped. */
class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type { Html };

export type HtmlValue = Html | string | number | boolean | null | undefined | HtmlValue[];

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

function emit(value: HtmlValue): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(emit).join('');
  // `cond && html\`…\`` renders nothing when the condition is false, as in JSX.
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  return escapeHtml(String(value));
}

/** Escapes every interpolation except nested `html` output. Whitespace that
 *  contains a line break is dropped from the template text, the way JSX drops
 *  it, so a template can be laid out readably without adding text nodes. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let out = '';
  strings.forEach((text, i) => {
    out += text.replace(/\s*\n\s*/g, '');
    if (i < values.length) out += emit(values[i]!);
  });
  return new Html(out);
}

/** An optional attribute: absent for null, undefined or false, empty for true. */
export function attr(name: string, value: string | number | boolean | null | undefined): Html {
  if (value === null || value === undefined || value === false) return new Html('');
  return new Html(` ${name}="${value === true ? '' : escapeHtml(String(value))}"`);
}
