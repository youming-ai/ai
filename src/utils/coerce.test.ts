import { describe, expect, it } from 'vitest';
import { decodeEntities, escapeXml } from './coerce';

describe('decodeEntities', () => {
  it('decodes numeric and named entities', () => {
    expect(decodeEntities('&amp; &lt; &mdash; &#8217;')).toBe('& < — ’');
  });

  it('drops out-of-range numeric references instead of throwing', () => {
    // One of these used to throw out of String.fromCodePoint, which aborted the
    // whole parse — and so every feed refresh after it, for as long as the
    // item stayed in the rolling feed.
    expect(() => decodeEntities('&#1114112;')).not.toThrow();
    expect(decodeEntities('a&#1114112;b')).toBe('ab');
    expect(decodeEntities('a&#x110000;b')).toBe('ab');
    expect(decodeEntities('a&#-1;b')).toBe('a&#-1;b');
  });

  it('drops surrogate code points, which cannot be encoded as UTF-8', () => {
    expect(decodeEntities('a&#55296;b')).toBe('ab');
    expect(decodeEntities('a&#57343;b')).toBe('ab');
    // A valid astral code point still decodes, as a well-formed pair.
    expect(decodeEntities('&#128512;')).toBe('\u{1F600}');
  });
});

describe('escapeXml', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml('a<b>&"\'')).toBe('a&lt;b&gt;&amp;&quot;&apos;');
  });

  it('strips characters XML 1.0 cannot represent, which would void the document', () => {
    // Numeric references decode to these, and JS `\s` (all stripHtml collapses)
    // does not cover most of them. One anywhere makes the feed non-well-formed
    // for every subscriber.
    expect(escapeXml('a\u0001b\u0008c\u001fd')).toBe('abcd');
    expect(escapeXml('\ufffe\uffff')).toBe('');
    expect(escapeXml('keeps\u0009tab\u000aline')).toBe('keeps\u0009tab\u000aline');
  });

  it('strips lone surrogates but keeps a valid pair', () => {
    expect(escapeXml('a\ud800b')).toBe('ab');
    expect(escapeXml('a\udc00b')).toBe('ab');
    expect(escapeXml('\u{1F600}')).toBe('\u{1F600}');
  });
});
