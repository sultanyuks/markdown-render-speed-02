// A fast, dependency-free Markdown renderer.
//
// The HTML it produces matches, byte for byte, the output of the `marked`
// parser (v18) run with its default options: GFM enabled, line breaks off,
// pedantic mode off. The implementation here is an original single-purpose
// engine written for speed: block structure is recognised with a
// first-character dispatch over anchored grammar patterns, inline text is
// scanned once with delimiter-run matching for emphasis, and the token
// tree is rendered straight to a string with no intermediate DOM or AST
// copies beyond the tokens themselves.
//
// Grammar notes (the behaviour this engine reproduces):
// - Block order: blank lines, indented code, fenced code, ATX headings,
//   thematic breaks, block quotes, lists, raw HTML blocks, link reference
//   definitions, GFM tables, setext headings, paragraphs, plain text.
// - Inline order: backslash escapes, raw HTML tags, inline links, reference
//   links, emphasis/strong delimiter runs, code spans, hard breaks,
//   strikethrough, autolinks, GFM extended autolinks, plain text.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPE_MAP[ch];

// Escape every HTML-special character, including ampersands that already
// look like an entity (used for code and for autolink text).
function escapeAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, escapeChar);
}

// Escape HTML-special characters but leave an ampersand alone when it
// begins something shaped like a character reference (used for text).
const BARE_AMP = /&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function escapeText(s) {
  if (!/[<>"']/.test(s) && !BARE_AMP.test(s)) return s;
  return s.replace(/[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeChar);
}

// Decode numeric character references in a run of plain text. A reference
// to code point 0, a surrogate, or a value past U+10FFFF becomes U+FFFD;
// a reference to `&` stays an entity; an ampersand that starts no valid
// reference is written out as an entity itself.
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Clean a link destination the way the reference renderer does: run it
// through URI encoding, then undo the encoding of literal percent signs.
// A destination that cannot be encoded at all makes the link render as
// plain text, signalled here by null.
const HREF_SAFE = /^[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#%]*$/;
function cleanHref(href) {
  // Fast path: a destination made only of characters URI encoding
  // leaves alone, with no literal "%25" for the undo step to rewrite,
  // comes through unchanged.
  if (HREF_SAFE.test(href) && !href.includes('%25')) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove up to one trailing newline's worth of blank lines from the end
// of a raw block: trailing blank lines are dropped only when there are
// more than two line ends involved.
function trimTrailingBlankLines(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  if (lines.length - last <= 2) return s;
  return lines.slice(0, last + 1).join('\n');
}

// Strip characters equal to `ch` from the end of `s`.
function stripTrailing(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Normalise a link label for lookup: trim, collapse whitespace runs to a
// single space, and case-fold (via upper then lower, so characters whose
// upper and lower forms differ in length fold the same way every time).
function normaliseLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the closing bracket for a run of parentheses in `s`: returns the
// index where the balance first goes negative, -1 when balanced, and -2
// when an opener is never closed. Backslash-escaped characters are skipped.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tab characters in `s` to spaces, treating the text as starting
// at column `col`, so a tab advances to the next multiple-of-four column.
function expandTabs(s, col = 0) {
  if (!s.includes('\t')) return s;
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grammar patterns. Each is anchored at the current position.
// ---------------------------------------------------------------------------

// Assemble a pattern from a template with named slots, in the style of a
// grammar composer: `fill` swaps each slot name for a fragment pattern.
// A fragment's leading anchor is dropped when it is embedded, since the
// composite pattern supplies the anchoring (an anchor inside a character
// class is a literal caret and is kept).
function stripAnchors(src) {
  return src.replace(/(^|[^\[])\^/g, '$1');
}
function fill(template, slots) {
  let src = typeof template === 'string' ? template : template.source;
  for (const key of Object.keys(slots)) {
    const frag = slots[key];
    src = src.split(key).join(stripAnchors(typeof frag === 'string' ? frag : frag.source));
  }
  return new RegExp(src);
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const COMMENT_SRC = String.raw`<!--(?:-?>|[\s\S]*?(?:-->|$))`;
const ATTR_SRC = String.raw` +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>` + '`' + String.raw`]+)?`;

const RE = {
  blankLines: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  codeStripIndent: /^(?: {0,3}\t| {1,4})/gm,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  fenceIndent: /^(\s+)(?:```)/,
  lineStartSpaces: /^ */,
  atxHeading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  trailingHashes: /#+$/,
  trailingSpaceTab: /[ \t]$/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  setextUnderline: /^ {0,3}(=+|-+)[ \t]*$/,
  listStart: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  bulletOnly: / {0,3}(?:[*+-]|\d{1,9}[.)])/,
  defLabel: /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/,
  defTitle: /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
  angleHref: /^<(.*)>$/,
  tableCellAlignR: /^ *-+: *$/,
  tableCellAlignC: /^ *:-+: *$/,
  tableCellAlignL: /^ *:-+ *$/,
  taskItem: /^\[[ xX]\][ \t]+\S/,
  taskStrip: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  blankLineTest: /^[ \t]*$/,
  doubleBlank: /\n[ \t]*\n[ \t]*$/,
  anyInnerLine: /\n.*\n/,
  quoteStart: /^ {0,3}>/,
  quoteMarker: /^ {0,3}>[ \t]?/gm,
  quoteMarkerSpace: /^( {0,3}>)([ \t]+)/gm,
  quoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  nonSpace: /\S/,
  firstWord: /^\S*/,
  endingNewline: /\n$/,
};

RE.def = fill(
  String.raw`^ {0,3}\[(LABEL)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(TITLE))? *(?:\n+|$)`,
  { LABEL: RE.defLabel, TITLE: RE.defTitle },
);

RE.htmlBlock = fill(
  String.raw`^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:</\1>[^\n]*\n*|$)|COMMENT[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|</?(TAG)(?:[ \t]+|\n|/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|</[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))`,
  { COMMENT: COMMENT_SRC, TAG: BLOCK_TAGS, ATTR: ATTR_SRC },
);
RE.htmlBlock = new RegExp(RE.htmlBlock.source, 'i');

// A paragraph's continuation lines stop before any of these constructs.
const PARA_INTERRUPT = {
  hr: RE.hr,
  heading: / {0,3}#{1,6}(?:\s|$)/,
  blockquote: / {0,3}>/,
  fences: / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
  listGfm: / {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+[^ \t\n]/,
  listPlain: / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/,
  html: new RegExp(
    String.raw` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)`,
  ),
  table: null, // filled in below, once the table pattern exists
};

RE.table = fill(
  String.raw`^ *([^\n]*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|HR|HEADING|BLOCKQUOTE|CODE|FENCES|LIST|HTML).*(?:\n|$))*)\n*|$)`,
  {
    HR: RE.hr,
    HEADING: / {0,3}#{1,6}(?:\s|$)/,
    BLOCKQUOTE: / {0,3}>/,
    CODE: /(?: {4}| {0,3}\t)[^\n]/,
    FENCES: / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
    LIST: / {0,3}(?:[*+-]|1[.)])[ \t]/,
    HTML: new RegExp(
      String.raw` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)`,
    ),
  },
);
PARA_INTERRUPT.table = RE.table;

// Setext heading: a run of paragraph-like lines followed by an underline
// of `=` (level 1) or `-` (level 2). The heading may not itself start
// with a list item, indented code, a fence, a quote, an ATX heading, an
// HTML line or a table delimiter, and its continuation lines stop before
// blank lines and most other block starts.
const SETEXT_GUARD =
  String.raw` {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n`;
RE.setext = new RegExp(
  String.raw`^(?!(?:${SETEXT_GUARD}|(?: {4}| {0,3}\t)))((?:.|\n(?!\s*?\n|${SETEXT_GUARD}| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)`,
);

// The paragraph pattern is assembled per call site because the set of
// interrupting constructs differs between the top level, block quotes
// and list items. `interrupt` is a list of pattern sources for the
// negative lookahead that ends a paragraph.
function paragraphPattern(interrupts) {
  return new RegExp(
    String.raw`^([^\n]+(?:\n(?!(?:${interrupts.map(stripAnchors).join('|')})|[ \t]+\n)[^\n]+)*)`,
  );
}
RE.paragraphTop = paragraphPattern([
  PARA_INTERRUPT.hr.source,
  PARA_INTERRUPT.heading.source,
  PARA_INTERRUPT.blockquote.source,
  PARA_INTERRUPT.fences.source,
  PARA_INTERRUPT.listPlain.source,
  PARA_INTERRUPT.html.source,
  RE.table.source,
]);
RE.paragraphQuote = paragraphPattern([
  PARA_INTERRUPT.hr.source,
  PARA_INTERRUPT.heading.source,
  PARA_INTERRUPT.blockquote.source,
  PARA_INTERRUPT.fences.source,
  / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.source,
  PARA_INTERRUPT.html.source,
]);
RE.blockquote = fill(
  String.raw`^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(PARA)|[^\n]*)(?:\n|$))+`,
  { PARA: RE.paragraphQuote },
);

// ---------------------------------------------------------------------------
// Inline grammar patterns
// ---------------------------------------------------------------------------

const INL = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  tag: new RegExp(
    String.raw`^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>` + '`' + String.raw`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>`,
  ),
  autolink:
    /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink:
    /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch:
    /!?\[((?:[^\[\]\\`]*(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  blockSkip:
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  anyPunctOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  emLDelim:
    /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emRDelimAst:
    /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emRDelimUnd:
    /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim:
    /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  outputLinkEscape: /\\([\[\]])/g,
  unicodeAlnum: /[\p{L}\p{N}]/u,
};

// Remove backslash escapes of punctuation: `\*` becomes `*`, and so on.
function unescapePunct(s) {
  if (!s.includes('\\')) return s;
  return s.replace(INL.anyPunctuation, '$1');
}

function htmlBeginPattern(indent) {
  return new RegExp(
    String.raw`^ {0,${indent}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)`,
    'i',
  );
}

// The block-start probes used while collecting list item lines depend
// only on the clamped indent (0-3), so they are compiled once each.
const probeCache = [null, null, null, null];
function probePatterns(probe) {
  let p = probeCache[probe];
  if (p === null) {
    p = {
      nextBullet: new RegExp(`^ {0,${probe}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
      hr: new RegExp(`^ {0,${probe}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
      fences: new RegExp(`^ {0,${probe}}(?:\`\`\`|~~~)`),
      heading: new RegExp(`^ {0,${probe}}#{1,6}(?:\\s|$)`),
      html: htmlBeginPattern(probe),
      quote: new RegExp(`^ {0,${probe}}>`),
    };
    probeCache[probe] = p;
  }
  return p;
}

// The per-item pattern depends only on the list's bullet or delimiter.
const itemReCache = new Map();
function itemPattern(bulletPat) {
  let re = itemReCache.get(bulletPat);
  if (re === undefined) {
    re = new RegExp(`^( {0,3}${bulletPat})((?:[\t ][^\\n]*)?(?:\\n|$))`);
    itemReCache.set(bulletPat, re);
  }
  return re;
}

// ---------------------------------------------------------------------------
// Block parsing. A context carries the link definitions collected so far
// and the "top level" flag that decides whether a paragraph may start.
// ---------------------------------------------------------------------------

function fenceContent(raw, content) {
  const lead = raw.match(RE.fenceIndent);
  if (lead === null) return content;
  const width = lead[1].length;
  return content
    .split('\n')
    .map((line) => {
      const sp = line.match(/^\s+/);
      if (sp === null) return line;
      return line.slice(Math.min(sp[0].length, width));
    })
    .join('\n');
}

function splitCells(s, count) {
  const marked = s.replace(/\|/g, (ch, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// A table can only start when the second line is a delimiter row: only
// pipes, colons, dashes and spaces, with at least one dash and at least
// one pipe or colon. This cheap test keeps the full table pattern from
// running at most block starts.
function tableMayStart(src) {
  const firstNl = src.indexOf('\n');
  if (firstNl === -1) return false;
  const secondEnd = src.indexOf('\n', firstNl + 1);
  const line2 = secondEnd === -1 ? src.slice(firstNl + 1) : src.slice(firstNl + 1, secondEnd);
  return /^[|:\- ]+$/.test(line2) && line2.includes('-') && /[:|]/.test(line2);
}

// A setext heading needs an underline line (`=` or `-` run) somewhere in
// the unbroken run of lines that starts here.
function setextPossible(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    const end = src.indexOf('\n', pos);
    const line = end === -1 ? src.slice(pos) : src.slice(pos, end);
    if (/^[ \t]*$/.test(line)) return false;
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) return true;
    if (end === -1) return false;
    pos = end + 1;
  }
  return false;
}

function lexTable(src) {
  const m = RE.table.exec(src);
  if (m === null) return undefined;
  if (!/[:|]/.test(m[2])) return undefined;
  const headerCells = splitCells(m[1]);
  const alignSrc = m[2].replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignSrc.length) return undefined;
  const align = alignSrc.map((cell) =>
    RE.tableCellAlignR.test(cell) ? 'right' : RE.tableCellAlignC.test(cell) ? 'center' : RE.tableCellAlignL.test(cell) ? 'left' : null,
  );
  const header = headerCells.map((text, i) => ({ text, align: align[i] }));
  const rows = [];
  if (m[3] !== undefined && m[3].trim()) {
    const bodyLines = m[3].replace(/\n[ \t]*$/, '').split('\n');
    for (const line of bodyLines) {
      rows.push(splitCells(line, header.length).map((text, i) => ({ text, align: align[i] })));
    }
  }
  return { t: 'table', raw: stripTrailing(m[0], '\n'), header, rows, align };
}

// Per-line interrupt tests for the paragraph scanner: a paragraph's
// continuation lines stop before a thematic break, an ATX heading, a
// quote, a fence, a list item, an HTML block start or a table.
const PARA_LINE = {
  spaces: /^[ \t]+$/,
  heading: /^ {0,3}#{1,6}(?:\s|$)/,
  quote: /^ {0,3}>/,
  fence: /^ {0,3}(?:`{3,}[^`\n]*$|~{3,})/,
  list: /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/,
  html: new RegExp(
    String.raw`^ {0,3}(?:<\/?(?:${BLOCK_TAGS})(?: +|$|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)`,
  ),
};

// Scan a paragraph at the head of `src`: the first line, plus every
// following line that does not start an interrupting construct and is
// not blank. Returns the consumed length, or 0 when there is no line.
function lexParagraph(src) {
  const firstEnd = src.indexOf('\n');
  const firstLine = firstEnd === -1 ? src : src.slice(0, firstEnd);
  if (firstLine.length === 0) return 0;
  let consumed = firstLine.length;
  let pos = firstEnd === -1 ? src.length : firstEnd + 1;
  while (pos < src.length) {
    const end = src.indexOf('\n', pos);
    const line = end === -1 ? src.slice(pos) : src.slice(pos, end);
    if (line.length === 0) break;
    if (end !== -1 && PARA_LINE.spaces.test(line)) break;
    const lc = leadChar(line);
    if (
      ((lc === '-' || lc === '*' || lc === '_') && RE.hr.test(line + '\n')) ||
      (lc === '#' && PARA_LINE.heading.test(line)) ||
      (lc === '>' && PARA_LINE.quote.test(line)) ||
      ((lc === '`' || lc === '~') && PARA_LINE.fence.test(line)) ||
      ((lc === '-' || lc === '*' || lc === '+' || (lc >= '0' && lc <= '9')) && PARA_LINE.list.test(line)) ||
      (lc === '<' && PARA_LINE.html.test(line))
    ) {
      break;
    }
    if (tableMayStart(src.slice(pos)) && RE.table.exec(src.slice(pos)) !== null) break;
    consumed = end === -1 ? src.length : end;
    if (end === -1) break;
    pos = end + 1;
  }
  return consumed;
}

// The character that follows up to three leading spaces of a line, used
// to skip block patterns that cannot match at this position.
function leadChar(src) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === 32) i++;
  return src.charAt(i);
}

function lexBlocks(src, ctx, out, mergePara) {
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let m;
    const last = out[out.length - 1];
    const c0 = src.charCodeAt(0);

    // Blank lines.
    if ((c0 === 32 || c0 === 9 || c0 === 10) && (m = RE.blankLines.exec(src)) !== null && m[0].length > 0) {
      src = src.slice(m[0].length);
      if (m[0].length === 1 && last !== undefined) last.raw += '\n';
      else out.push({ t: 'space', raw: m[0] });
      continue;
    }

    // Indented code; absorbed into a preceding paragraph or text token.
    if ((c0 === 32 || c0 === 9) && (m = RE.indentedCode.exec(src)) !== null) {
      const raw = trimTrailingBlankLines(m[0]);
      const text = raw.replace(RE.codeStripIndent, '');
      src = src.slice(m[0].length);
      if (last !== undefined && (last.t === 'paragraph' || last.t === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
      } else {
        out.push({ t: 'code', raw, text, lang: undefined });
      }
      continue;
    }

    const lead = leadChar(src);

    // Fenced code.
    if ((lead === '`' || lead === '~') && (m = RE.fences.exec(src)) !== null) {
      src = src.slice(m[0].length);
      out.push({
        t: 'code',
        raw: m[0],
        text: fenceContent(m[0], m[3] || ''),
        lang: m[2] ? unescapePunct(m[2].trim()) : m[2],
      });
      continue;
    }

    // ATX heading.
    if (lead === '#' && (m = RE.atxHeading.exec(src)) !== null) {
      src = src.slice(m[0].length);
      let text = m[2].trim();
      if (RE.trailingHashes.test(text)) {
        const stripped = stripTrailing(text, '#');
        if (stripped === '' || RE.trailingSpaceTab.test(stripped)) text = stripped.trim();
      }
      out.push({ t: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[1].length, text });
      continue;
    }

    // Thematic break.
    if ((lead === '-' || lead === '*' || lead === '_') && (m = RE.hr.exec(src)) !== null) {
      src = src.slice(m[0].length);
      out.push({ t: 'hr', raw: stripTrailing(m[0], '\n') });
      continue;
    }

    // Block quote.
    if (lead === '>') {
      const quote = lexBlockquote(src, ctx);
      if (quote !== undefined) {
        src = src.slice(quote.raw.length);
        out.push(quote);
        continue;
      }
    }

    // List.
    const list = lexList(src, ctx);
    if (list !== undefined) {
      src = src.slice(list.raw.length);
      out.push(list);
      continue;
    }

    // Raw HTML block.
    if (lead === '<' && (m = RE.htmlBlock.exec(src)) !== null) {
      src = src.slice(m[0].length);
      const raw = trimTrailingBlankLines(m[0]);
      out.push({ t: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      continue;
    }

    // Link reference definition; absorbed into a preceding paragraph or
    // text token when there is one (in which case it is not registered).
    if (lead === '[' && (m = RE.def.exec(src)) !== null) {
      if (m[2].charAt(0) !== '<' && parenBalance(m[2]) !== -1) {
        // Unbalanced parentheses in the destination: not a definition.
      } else {
        src = src.slice(m[0].length);
        const tok = {
          t: 'def',
          raw: stripTrailing(m[0], '\n'),
          tag: normaliseLabel(m[1]),
          href: m[2] ? unescapePunct(m[2].replace(RE.angleHref, '$1')) : '',
          title: m[3] ? unescapePunct(m[3].substring(1, m[3].length - 1)) : undefined,
        };
        if (last !== undefined && (last.t === 'paragraph' || last.t === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
        } else {
          if (!(tok.tag in ctx.links)) {
            ctx.links[tok.tag] = { href: tok.href, title: tok.title };
            ctx.hasLinks = true;
          }
          out.push(tok);
        }
        continue;
      }
    }

    // GFM table.
    if (tableMayStart(src)) {
      const table = lexTable(src);
      if (table !== undefined) {
        src = src.slice(table.raw.length);
        out.push(table);
        continue;
      }
    }

    // Setext heading.
    if (setextPossible(src) && (m = RE.setext.exec(src)) !== null) {
      src = src.slice(m[0].length);
      out.push({
        t: 'heading',
        raw: stripTrailing(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text: m[1].trim(),
      });
      continue;
    }

    // Paragraph (top level only); inside a block quote a paragraph that
    // follows another is folded into it.
    if (ctx.top) {
      const plen = lexParagraph(src);
      if (plen > 0) {
        const raw = src.slice(0, plen);
        src = src.slice(plen);
        if (mergePara && last !== undefined && last.t === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
        } else {
          out.push({ t: 'paragraph', raw, text: raw });
        }
        mergePara = false;
        continue;
      }
    }

    // Plain text fallback: a single line, folded into a previous text token.
    if ((m = /^[^\n]+/.exec(src)) !== null) {
      src = src.slice(m[0].length);
      if (last !== undefined && last.t === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
      } else {
        out.push({ t: 'text', raw: m[0], text: m[0] });
      }
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return out;
}

function lexBlockquote(src, ctx) {
  const m = RE.blockquote.exec(src);
  if (m === null) return undefined;
  let lines = stripTrailing(m[0], '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const tokens = [];
  while (lines.length > 0) {
    // One group: quoted lines plus any lazy lines that precede a quote
    // marker (there are none in practice, but the grouping is kept).
    const group = [];
    let seenMarker = false;
    let p = 0;
    for (; p < lines.length; p++) {
      if (RE.quoteStart.test(lines[p])) {
        group.push(lines[p]);
        seenMarker = true;
      } else if (!seenMarker) {
        group.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const joined = group.join('\n');
    const cleaned = joined
      .replace(RE.quoteMarkerSpace, (mm, g1, g2) => g1 + expandTabs(g2, g1.length))
      .replace(RE.quoteSetext, '\n    $1')
      .replace(RE.quoteMarker, '');
    rawAll = rawAll ? rawAll + '\n' + joined : joined;
    textAll = textAll ? textAll + '\n' + cleaned : cleaned;
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(cleaned, ctx, tokens, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const lastTok = tokens[tokens.length - 1];
    if (
      lastTok !== undefined &&
      (lastTok.t === 'code' || lastTok.t === 'heading' || lastTok.t === 'hr' || lastTok.t === 'html' || lastTok.t === 'table')
    ) {
      break;
    }
    if (lastTok !== undefined && lastTok.t === 'blockquote') {
      // The quote continues past a nested quote: re-parse them together.
      const rest = lines.join('\n');
      const combined = lastTok.raw + '\n' + rest.replace(RE.quoteMarker, '');
      const merged = lexBlockquote(combined, ctx);
      tokens[tokens.length - 1] = merged;
      const after = combined.substring(merged.raw.length).replace(/^\n/, '');
      const restCount = after ? after.split('\n').length : 0;
      const consumed = restCount ? lines.slice(0, -restCount) : lines;
      if (consumed.length > 0) rawAll += '\n' + consumed.join('\n');
      textAll = textAll.substring(0, textAll.length - lastTok.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RE.quoteStart.test(lines[0])) continue;
      break;
    }
    if (lastTok !== undefined && lastTok.t === 'list') {
      // The quote continues past a list: re-parse them together.
      const combined = lastTok.raw + '\n' + lines.join('\n');
      const merged = lexList(combined, ctx);
      tokens[tokens.length - 1] = merged;
      let consumedCount = 0;
      if (merged.raw.length > lastTok.raw.length) {
        consumedCount = combined.slice(lastTok.raw.length + 1, merged.raw.length).split('\n').length;
      }
      if (consumedCount > 0) {
        const seg = lines.slice(0, consumedCount).join('\n');
        rawAll += '\n' + seg;
        textAll += '\n' + seg;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { t: 'blockquote', raw: rawAll, tokens, text: textAll };
}

function lexList(src, ctx) {
  const start = RE.listStart.exec(src);
  if (start === null) return undefined;
  const bullet = start[1].trim();
  const ordered = bullet.length > 1;
  const startNum = ordered ? +bullet.slice(0, -1) : '';
  const bulletPat = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = itemPattern(bulletPat);
  const list = { t: 'list', raw: '', ordered, start: startNum, loose: false, items: [] };
  let pos = 0;
  let seenBlankItem = false;
  while (pos < src.length) {
    const rest = src.slice(pos);
    const im = itemRe.exec(rest);
    if (im === null || RE.hr.test(rest)) break;
    const itemStart = pos;
    pos += im[0].length;
    const bulletLen = im[1].length;
    const firstContent = (im[2].endsWith('\n') ? im[2].slice(0, -1) : im[2]).replace(/^[ \t]+/, (v) =>
      expandTabs(v, bulletLen),
    );
    const isBlank = !firstContent.trim();
    let indent;
    let text;
    if (isBlank) {
      indent = bulletLen + 1;
      text = '';
    } else {
      let r = firstContent.search(RE.nonSpace);
      if (r > 4) r = 1;
      text = firstContent.slice(r);
      indent = r + bulletLen;
    }
    let itemDone = false;
    if (isBlank) {
      const nl = src.indexOf('\n', pos);
      const nextLine = nl === -1 ? src.slice(pos) : src.slice(pos, nl);
      if (RE.blankLineTest.test(nextLine)) {
        pos += nextLine.length + 1;
        itemDone = true;
      }
    }
    if (!itemDone) {
      // The "can a new block start here" probes tolerate at most three
      // spaces of indent, however deep the item itself is indented.
      const probe = Math.max(0, Math.min(3, indent - 1));
      const probes = probePatterns(probe);
      const nextBulletRe = probes.nextBullet;
      const hrRe = probes.hr;
      const fencesRe = probes.fences;
      const headingRe = probes.heading;
      const htmlRe = probes.html;
      const quoteRe = probes.quote;
      let prevBlank = isBlank;
      let prevContent = firstContent;
      while (pos < src.length) {
        const nl = src.indexOf('\n', pos);
        const line = nl === -1 ? src.slice(pos) : src.slice(pos, nl);
        const lc0 = line.charCodeAt(0);
        const expanded =
          lc0 === 32 || lc0 === 9 ? line.replace(/^[ \t]+/, (v) => expandTabs(v)) : line;
        const ll = leadChar(line);
        if (
          (ll === '>' && quoteRe.test(line)) ||
          ((ll === '`' || ll === '~') && fencesRe.test(line)) ||
          (ll === '#' && headingRe.test(line)) ||
          ((ll === '-' || ll === '*' || ll === '+' || (ll >= '0' && ll <= '9')) && nextBulletRe.test(line)) ||
          ((ll === '-' || ll === '*' || ll === '_') && hrRe.test(line)) ||
          (ll === '<' && htmlRe.test(line))
        ) {
          break;
        }
        if (expanded.search(RE.nonSpace) >= indent || !line.trim()) {
          text += '\n' + expanded.slice(indent);
        } else {
          // A lazy continuation line, unless the previous line was blank,
          // deeply indented, or itself the start of another block.
          if (
            prevBlank ||
            prevContent.replace(/\t/g, '    ').search(RE.nonSpace) >= 4 ||
            fencesRe.test(prevContent) ||
            headingRe.test(prevContent) ||
            htmlRe.test(prevContent) ||
            hrRe.test(prevContent)
          ) {
            break;
          }
          let add = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && RE.setext.test(prevContent + '\n' + line)) {
            add = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          text += '\n' + add;
        }
        prevBlank = !line.trim();
        pos += line.length + 1;
        prevContent = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, pos);
    if (!list.loose) {
      if (seenBlankItem) list.loose = true;
      else if (RE.doubleBlank.test(itemRaw)) seenBlankItem = true;
    }
    list.items.push({
      t: 'list_item',
      raw: itemRaw,
      task: RE.taskItem.test(text),
      checked: false,
      loose: false,
      text,
      tokens: [],
    });
  }
  if (list.items.length === 0) return undefined;
  const lastItem = list.items[list.items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, pos).trimEnd();

  for (const item of list.items) {
    ctx.top = false;
    item.tokens = lexBlocks(item.text, ctx, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.t === 'space');
      if (spaces.length > 0 && spaces.some((tok) => RE.anyInnerLine.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first !== undefined && (first.t === 'text' || first.t === 'paragraph')) {
      item.text = item.text.replace(RE.taskStrip, '');
      first.raw = first.raw.replace(RE.taskStrip, '');
      first.text = first.text.replace(RE.taskStrip, '');
      const box = RE.taskBox.exec(item.raw);
      if (box !== null) {
        const checkbox = { t: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) first.checkbox = checkbox;
        else item.tokens.unshift(checkbox);
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.t === 'text') tok.t = 'paragraph';
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Inline parsing. Inline state (inside a link, inside a raw HTML block,
// whether a link was emitted, whether an inline link may still close)
// lives on a per-document state object, mirroring the reference lexer's
// behaviour, including the masking pass that hides code spans, link
// destinations and reference labels before emphasis closers are sought.
// ---------------------------------------------------------------------------

function scanClosers(masked) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastDel = s;
      else lastEm[r] = s;
    }
    s = i - 1;
  }
  return { lastEm, lastDel };
}

function linkInText(ctx, s) {
  if (!s.includes('[')) return false;
  INL.blockSkip.lastIndex = 0;
  for (const match of s.matchAll(INL.blockSkip)) {
    if (INL.link.test(match[0]) && s.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of s.matchAll(INL.reflinkSearch)) {
    const whole = match[0];
    const r = whole.lastIndexOf('[');
    if (
      !(whole.charAt(0) === '!' || !(normaliseLabel(whole.slice(r + 1, -1)) in ctx.links)) &&
      !(r > 1 && linkInText(ctx, whole.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

// True when the label of a would-be link contains a `<` that opens a tag
// or autolink reaching past the end of the label: such text is not a link.
function labelHasOpenTag(src, label, offset, ctx) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const code = INL.code.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const tag = INL.tag.exec(rest) || INL.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Build the masked twin of an inline source: reference-link labels and
// destinations, code spans and escapes are hidden behind filler letters
// so delimiter scanning is not confused by their contents. The mask has
// exactly the same length as the source.
function maskInline(ctx, src) {
  let masked = src;
  if (ctx.hasLinks && src.includes('[') && src.includes(']')) {
    const hide = (whole) => {
      const open = whole.lastIndexOf('[');
      if (!(normaliseLabel(whole.slice(open + 1, -1)) in ctx.links)) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (linkInText(ctx, inner)) {
          return '[' + inner.replace(INL.reflinkSearch, hide) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    masked = masked.replace(INL.reflinkSearch, hide);
  }
  // The code-span/escape mask can only change something when the source
  // holds a backtick or a backslash; the block-skip mask only when it
  // holds a bracket, backtick or angle bracket.
  if (masked.includes('`') || masked.includes('\\')) {
    masked = masked.replace(INL.anyPunctOutsideCode, (whole, codeRun, escaped) => {
      if (escaped) return '+'.repeat(whole.length);
      if (codeRun) return codeRun + whole.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun;
      return whole;
    });
  }
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(INL.blockSkip, (whole, aRun, prefix) => {
      const keep = prefix ? prefix.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
  }
  return masked;
}

// Try to read an emphasis or strong token at the head of `src`, where
// `maskedFull` is the masked form of the whole inline string this call is
// working on and `prevChar` is the last character of the preceding text.
function emStrong(ctx, src, maskedFull, prevChar, closers) {
  const open = INL.emLDelim.exec(src);
  if (open === null || (!open[1] && !open[2] && !open[3] && !open[4])) return undefined;
  const delim = open[0].charAt(0);
  const sameAsPrev = prevChar === delim;
  const fullLen = maskedFull.length;
  const remainLen = src.length;
  let runStart = fullLen - remainLen;
  const scanFrom = runStart;
  while (!ctx.gfmPedantic && runStart > 0 && maskedFull[runStart - 1] === delim) runStart--;
  const charBeforeRun = [...maskedFull.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsDelimOrPunct =
    charBeforeRun === '*' || charBeforeRun === '_' || !!INL.punctuation.exec(charBeforeRun);
  let prev = prevChar;
  if (runStart < scanFrom) prev = charBeforeRun;
  const prevIsPunct = runStart < scanFrom ? beforeIsDelimOrPunct : !!INL.punctuation.exec(prev);
  const punctAfter = open[1] || open[3] || '';
  if (open[4] && INL.unicodeAlnum.test(prev)) return undefined;
  if (!punctAfter || !prev || prevIsPunct) {
    const runLen = [...open[0]].length - 1;
    let need = runLen;
    let surplus = 0;
    const posInFull = fullLen - remainLen + runLen;
    const intrawordOk = !!charBeforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsDelimOrPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const rdelim = delim === '*' ? INL.emRDelimAst : INL.emRDelimUnd;
    const lastCloser = closers.lastEm[delim];
    if (lastCloser < posInFull) return undefined;
    const rest = maskedFull.slice(fullLen - remainLen + runLen);
    const lastOffset = lastCloser - posInFull;
    rdelim.lastIndex = 0;
    let cm;
    while ((cm = rdelim.exec(rest)) !== null && cm.index <= lastOffset) {
      const grp = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
      if (!grp) continue;
      const glen = [...grp].length;
      if (cm[3] || cm[4]) {
        need += glen;
        continue;
      }
      if (cm[5] || cm[6] || intrawordOk) {
        if (sameAsPrev && (cm[5] || cm[6])) break;
        const openerMeasure = scanFrom - runStart + runLen;
        if (openerMeasure % 3 && !((openerMeasure + glen) % 3)) {
          // Rule of three: this closer cannot pair with the opener.
          surplus += glen;
          continue;
        }
      }
      need -= glen;
      if (need > 0) continue;
      const use = Math.min(glen, glen + need + surplus);
      const firstCharLen = [...cm[0]][0].length;
      const raw = src.slice(0, runLen + cm.index + firstCharLen + use);
      if (Math.min(runLen, use) % 2) {
        const inner = raw.slice(1, -1);
        return { t: 'em', raw, text: inner };
      }
      const inner = raw.slice(2, -2);
      return { t: 'strong', raw, text: inner };
    }
  }
  return undefined;
}

function delSpan(ctx, src, maskedFull, prevChar, closers) {
  const open = INL.delLDelim.exec(src);
  if (open === null) return undefined;
  if (!open[1] || !prevChar || INL.punctuation.exec(prevChar)) {
    const runLen = [...open[0]].length - 1;
    let need = runLen;
    const posInFull = maskedFull.length - src.length + runLen;
    if (closers.lastDel < posInFull) return undefined;
    const rest = maskedFull.slice(maskedFull.length - src.length + runLen);
    const lastOffset = closers.lastDel - posInFull;
    INL.delRDelim.lastIndex = 0;
    let cm;
    while ((cm = INL.delRDelim.exec(rest)) !== null && cm.index <= lastOffset) {
      const grp = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
      if (!grp) continue;
      let glen = [...grp].length;
      if (glen !== runLen) continue;
      if (cm[3] || cm[4]) {
        need += glen;
        continue;
      }
      need -= glen;
      if (need > 0) continue;
      glen = Math.min(glen, glen + need);
      const firstCharLen = [...cm[0]][0].length;
      const raw = src.slice(0, runLen + cm.index + firstCharLen + glen);
      const inner = raw.slice(runLen, raw.length - runLen);
      return { t: 'del', raw, text: inner };
    }
  }
  return undefined;
}

// Read a link or image at the head of `src` (the inline `[...](...)` form
// or a reference form resolved through `ctx.links`). The inline form is
// only attempted when an inline link may still close in this string.
function linkToken(ctx, src, st, allowInline) {
  let m = allowInline ? INL.link.exec(src) : null;
  if (m !== null) {
    const imageOffset = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasOpenTag(src, m[1], imageOffset, ctx)) return undefined;
    let dest = m[2].trim();
    if (dest.startsWith('<')) {
      if (!dest.endsWith('>')) return undefined;
      const stripped = stripTrailing(dest.slice(0, -1), '\\');
      if ((dest.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const bal = parenBalance(m[2]);
      if (bal === -2) return undefined;
      if (bal > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
        m = [m[0].substring(0, cut).trim(), m[1], m[2].substring(0, bal), ''];
      }
    }
    const tail = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - tail.length) % 2 === 0) return undefined;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (href.startsWith('<')) href = href.slice(1, -1);
    return finishLink(ctx, st, m, { href: unescapePunct(href), title: unescapePunct(title) }, m[0]);
  }
  let ref = INL.reflink.exec(src);
  let isRef = true;
  if (ref === null) {
    ref = INL.nolink.exec(src);
    isRef = false;
  }
  if (ref !== null) {
    const imageOffset = ref[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasOpenTag(src, ref[1], imageOffset, ctx)) return undefined;
    const def = ctx.links[normaliseLabel(isRef ? ref[2] || ref[1] : ref[1])];
    if (def === undefined) {
      const first = ref[0].charAt(0);
      return { t: 'text', raw: first, text: first };
    }
    return finishLink(ctx, st, ref, def, ref[0]);
  }
  return undefined;
}

// Shared tail of link reading: parse the label's inline content (which
// may not itself emit a link inside a link), then build the token.
function finishLink(ctx, st, match, def, raw) {
  const label = match[1].replace(INL.outputLinkEscape, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = parseInline(label, ctx, st, false);
  const emitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      st.inRawBlock = savedRaw;
      return undefined;
    }
    st.linkEmitted = true;
  }
  // An image's alt text is the label rendered as plain text: no tags, no
  // escaping, hard breaks dropped. Compute it with a text-only pass.
  let alt = null;
  if (isImage) {
    const rawBefore = st.inRawBlock;
    st.inLink = true;
    st.linkEmitted = false;
    alt = parseInline(label, ctx, st, true);
    st.linkEmitted = savedEmitted;
    st.inLink = savedInLink;
    st.inRawBlock = rawBefore;
  }
  return {
    t: isImage ? 'image' : 'link',
    raw,
    href: def.href,
    title: def.title || null,
    text: label,
    inner,
    alt,
  };
}

// Cheap prefix test for the extended-autolink pattern: a bare URL or
// email can only start with `www.`, a scheme, `mailto:`/`xmpp:`, or a
// run of email characters followed by `@`.
const URL_START = /^(?:www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:|[A-Za-z0-9._+-]+@)/;


// Parse one inline string to HTML. With `textOnly` set, the output is the
// plain-text rendering used for image alt attributes.
function parseInline(src, ctx, st, textOnly) {
  const savedParen = st.lpp;
  st.lpp = savedParen && src.includes(')');
  try {
    return inlineHtml(src, ctx, st, textOnly);
  } finally {
    st.lpp = savedParen;
  }
}

function renderLinkToken(tok, st) {
  const cleaned = cleanHref(tok.href);
  if (cleaned === null) return tok.inner;
  const href = escapeText(cleaned);
  let out = '<a href="' + href + '"';
  if (tok.title) out += ' title="' + escapeText(tok.title) + '"';
  return out + '>' + tok.inner + '</a>';
}

function renderImageToken(tok) {
  const cleaned = cleanHref(tok.href);
  if (cleaned === null) return escapeText(tok.text);
  let out = '<img src="' + escapeText(cleaned) + '" alt="' + escapeText(tok.alt ?? '') + '"';
  if (tok.title) out += ' title="' + escapeText(tok.title) + '"';
  return out + '>';
}

function renderAutolink(text, href, textOnly) {
  if (textOnly) return text;
  const cleaned = cleanHref(href);
  const inner = escapeAll(text);
  if (cleaned === null) return inner;
  return '<a href="' + escapeAll(cleaned) + '">' + inner + '</a>';
}

function inlineHtml(src, ctx, st, textOnly) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskInline(ctx, src) : src;
  const closers = needsMask ? scanClosers(masked) : null;
  let out = '';
  let rest = src;
  let prevChar = '';
  let prevWasText = false;
  while (rest) {
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    let m;
    // First-character dispatch: each construct below can only match at
    // the characters noted, so the others are skipped outright. The
    // attempt order among the constructs that remain is unchanged.
    const c = rest.charCodeAt(0);

    // Backslash escape (and, failing that, a backslash hard break).
    if (c === 92 && (m = INL.escape.exec(rest)) !== null) {
      out += textOnly ? m[1] : escapeText(m[1]);
      rest = rest.slice(m[0].length);
      continue;
    }

    // Raw HTML tag or comment; tracks <a> and raw-block state.
    if (c === 60 && (m = INL.tag.exec(rest)) !== null) {
      if (!st.inLink && INL.startATag.test(m[0])) st.inLink = true;
      else if (st.inLink && INL.endATag.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && INL.startPreScriptTag.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && INL.endPreScriptTag.test(m[0])) st.inRawBlock = false;
      out += m[0];
      rest = rest.slice(m[0].length);
      continue;
    }

    // Link or image, inline or reference form.
    if (c === 91 || (c === 33 && rest.charCodeAt(1) === 91)) {
      const linkTok = linkToken(ctx, rest, st, st.lpp !== false);
      if (linkTok !== undefined) {
        rest = rest.slice(linkTok.raw.length);
        if (linkTok.t === 'text') {
          out += textOnly ? linkTok.text : escapeText(linkTok.text);
        } else if (linkTok.t === 'image') {
          out += textOnly ? (linkTok.alt ?? '') : renderImageToken(linkTok);
        } else {
          out += textOnly ? plainTextOf(labelOf(linkTok), ctx, st) : renderLinkToken(linkTok, st);
        }
        continue;
      }
    }

    // Emphasis and strong emphasis.
    if ((c === 42 || c === 95) && closers !== null) {
      const em = emStrong(ctx, rest, masked, prevChar, closers);
      if (em !== undefined) {
        const inner = parseInline(em.text, ctx, st, textOnly);
        out += textOnly ? inner : em.t === 'em' ? '<em>' + inner + '</em>' : '<strong>' + inner + '</strong>';
        rest = rest.slice(em.raw.length);
        continue;
      }
    }

    // Code span.
    if (c === 96 && (m = INL.code.exec(rest)) !== null) {
      let text = m[2].replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
        text = text.slice(1, -1);
      }
      out += textOnly ? text : '<code>' + escapeAll(text) + '</code>';
      rest = rest.slice(m[0].length);
      continue;
    }

    // Hard break.
    if ((c === 32 || c === 92) && (m = INL.br.exec(rest)) !== null) {
      out += textOnly ? '' : '<br>';
      rest = rest.slice(m[0].length);
      continue;
    }

    // Strikethrough.
    if (c === 126 && closers !== null) {
      const del = delSpan(ctx, rest, masked, prevChar, closers);
      if (del !== undefined) {
        const inner = parseInline(del.text, ctx, st, textOnly);
        out += textOnly ? inner : '<del>' + inner + '</del>';
        rest = rest.slice(del.raw.length);
        continue;
      }
    }

    // Autolink in angle brackets.
    if (c === 60 && (m = INL.autolink.exec(rest)) !== null) {
      const text = m[1];
      const href = m[2] === '@' ? 'mailto:' + text : text;
      out += renderAutolink(text, href, textOnly);
      rest = rest.slice(m[0].length);
      continue;
    }

    // GFM extended autolink (bare URL or email), outside links only.
    if (!st.inLink && URL_START.test(rest) && (m = INL.url.exec(rest)) !== null) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + m[0];
      } else {
        let trimmed = m[0];
        let before;
        do {
          before = trimmed;
          trimmed = INL.backpedal.exec(trimmed)?.[0] ?? '';
        } while (before !== trimmed);
        text = trimmed;
        href = m[1] === 'www.' ? 'http://' + trimmed : trimmed;
      }
      out += renderAutolink(text, href, textOnly);
      rest = rest.slice(text.length);
      continue;
    }

    // Plain text run up to the next special character.
    if ((m = INL.text.exec(rest)) !== null) {
      const raw = m[0];
      if (raw.charAt(raw.length - 1) !== '_') prevChar = raw.charAt(raw.length - 1);
      prevWasText = true;
      out += st.inRawBlock ? raw : textOnly ? decodeNumericRefs(raw) : escapeText(decodeNumericRefs(raw));
      rest = rest.slice(raw.length);
      continue;
    }

    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return out;
}

// The label of a link token, kept for the text-only rendering path.
function labelOf(tok) {
  return tok.text;
}

// Render a label as plain text (used when a link appears inside an image
// alt or another text-only context).
function plainTextOf(label, ctx, st) {
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const out = parseInline(label, ctx, st, true);
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  return out;
}

// ---------------------------------------------------------------------------
// Rendering the block token tree to HTML
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderInlineText(text, ctx, st) {
  st.inRawBlock = false;
  return parseInline(text, ctx, st, false);
}

function renderTableCell(cell, ctx, st, header) {
  const tag = header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInlineText(cell.text, ctx, st) + `</${tag}>\n`;
}

function renderTokens(tokens, ctx, st) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>` + renderInlineText(tok.text, ctx, st) + `</h${tok.depth}>\n`;
        break;
      case 'code': {
        const langWord = tok.lang ? tok.lang.match(RE.firstWord)?.[0] : undefined;
        const body = tok.text ? tok.text.replace(RE.endingNewline, '') + '\n' : '';
        out += langWord
          ? '<pre><code class="language-' + escapeText(langWord) + '">' + escapeAll(body) + '</code></pre>\n'
          : '<pre><code>' + escapeAll(body) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell, ctx, st, true);
        let body = '';
        for (const row of tok.rows) {
          let rowHtml = '';
          for (const cell of row) rowHtml += renderTableCell(cell, ctx, st, false);
          body += '<tr>\n' + rowHtml + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens, ctx, st) + '</blockquote>\n';
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += '<li>' + renderTokens(item.tokens, ctx, st) + '</li>\n';
        const tag = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + startAttr + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += checkboxHtml(tok.checked);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + (tok.checkbox ? checkboxHtml(tok.checkbox.checked) : '') + renderInlineText(tok.text, ctx, st) + '</p>\n';
        break;
      case 'text':
        out += (tok.checkbox ? checkboxHtml(tok.checkbox.checked) : '') + renderInlineText(tok.text, ctx, st);
        break;
      default:
        throw new Error('Token with "' + tok.t + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render a Markdown string to HTML, matching marked 18.1.3 defaults. */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const ctx = { links: Object.create(null), top: true, hasLinks: false };
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, lpp: true };
  const tokens = lexBlocks(src, ctx, [], false);
  return renderTokens(tokens, ctx, st);
}
