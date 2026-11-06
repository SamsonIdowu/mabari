// SPDX-License-Identifier: Apache-2.0
// A small Markdown reader for what agents write. It makes a tree, never HTML: nothing in a message
// can become a tag, an attribute or a script, because the page draws the tree itself. Raw HTML in
// the text stays text. A link is kept only when it is a web or mail address, and an image is only
// ever a link, since loading it would send a request to wherever the message points.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  /** `open` is a fence still being written: the closing one hasn't arrived. */
  | { t: 'code'; lang: string; v: string; open: boolean }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right' | '')[] };

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * The address to link to, or null. Only http, https and mailto get through: `javascript:`, `data:`,
 * `vbscript:`, `file:` and a relative address are all refused, however they are spelled. The
 * browser's own URL parser decides what the scheme is, so a tab or newline hidden inside it can't
 * fool the check.
 */
export function safeHref(raw: string): string | null {
  const text = raw.trim();
  if (!text || /[\u0000-\u001f\u007f\s]/u.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Finds the end of a bracketed part that starts at `from` with `open`, honouring nesting. */
function closing(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      at++;
    } else if (char === open) {
      depth++;
    } else if (char === close && --depth === 0) {
      return at;
    }
  }
  return -1;
}

/** Trailing punctuation that belongs to the sentence, not to a bare address. */
function trimAddress(address: string): string {
  let end = address.length;
  while (end > 0) {
    const last = address[end - 1]!;
    const unbalanced =
      last === ')' &&
      address.slice(0, end).split(')').length > address.slice(0, end).split('(').length;
    if (/[.,;:!?'"]/.test(last) || unbalanced) end--;
    else break;
  }
  return address.slice(0, end);
}

function wordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.t === 'text') last.v += text;
  else out.push({ t: 'text', v: text });
}

/** Reads a run of text for spans: code, emphasis, links and the rest. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const length = text.length;
  while (at < length) {
    const char = text[at]!;
    if (char === '\\' && at + 1 < length && PUNCTUATION.test(text[at + 1]!)) {
      pushText(out, text[at + 1]!);
      at += 2;
      continue;
    }
    if (char === '\n') {
      out.push({ t: 'br' });
      at++;
      continue;
    }
    if (char === '`') {
      let run = at;
      while (text[run] === '`') run++;
      const ticks = text.slice(at, run);
      const end = text.indexOf(ticks, run);
      let close = end;
      // A longer run of backticks is not this span's end.
      while (close >= 0 && text[close + ticks.length] === '`') {
        close = text.indexOf(ticks, close + ticks.length + 1);
      }
      if (close > run) {
        let code = text.slice(run, close).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
          code = code.slice(1, -1);
        }
        out.push({ t: 'code', v: code });
        at = close + ticks.length;
      } else {
        pushText(out, ticks);
        at = run;
      }
      continue;
    }
    if (char === '[' || (char === '!' && text[at + 1] === '[')) {
      const image = char === '!';
      const start = image ? at + 1 : at;
      const end = closing(text, start, '[', ']');
      if (end > 0 && text[end + 1] === '(') {
        const stop = closing(text, end + 1, '(', ')');
        if (stop > 0) {
          const inside = text.slice(end + 2, stop).trim();
          const href = safeHref(inside.split(/\s+/)[0] ?? '');
          const label = text.slice(start + 1, end);
          if (href) {
            const children = parseInline(label);
            out.push({
              t: 'link',
              href,
              c: children.length ? children : [{ t: 'text', v: image ? 'image' : href }],
            });
          } else {
            // A link that can't be followed shows what it said, as text.
            for (const part of parseInline(label)) out.push(part);
          }
          at = stop + 1;
          continue;
        }
      }
    }
    if (char === '<') {
      const end = text.indexOf('>', at);
      const inside = end > at ? text.slice(at + 1, end) : '';
      const href = /^(https?:\/\/|mailto:)\S+$/i.test(inside) ? safeHref(inside) : null;
      if (href) {
        out.push({ t: 'link', href, c: [{ t: 'text', v: inside }] });
        at = end + 1;
        continue;
      }
    }
    if ((char === 'h' || char === 'H') && !wordChar(text[at - 1])) {
      const match = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(at));
      if (match) {
        const address = trimAddress(match[0]);
        const href = safeHref(address);
        if (href) {
          out.push({ t: 'link', href, c: [{ t: 'text', v: address }] });
          at += address.length;
          continue;
        }
      }
    }
    if (char === '*' || char === '_' || char === '~') {
      let run = at;
      while (text[run] === char) run++;
      const width = run - at;
      const wanted = char === '~' ? (width >= 2 ? 2 : 0) : Math.min(width, 2);
      const before = text[at - 1];
      const after = text[run];
      const opens =
        wanted > 0 &&
        after !== undefined &&
        !/\s/.test(after) &&
        !(char === '_' && wordChar(before));
      if (opens) {
        const mark = char.repeat(wanted);
        let close = run;
        let found = -1;
        while (close < length) {
          const next = text.indexOf(mark, close);
          if (next < 0) break;
          const prior = text[next - 1];
          const following = text[next + wanted];
          const closes =
            next > run &&
            prior !== undefined &&
            !/\s/.test(prior) &&
            !(char === '_' && wordChar(following)) &&
            // A longer run belongs to the delimiter that is part of it.
            text[next + wanted] !== char;
          if (closes) {
            found = next;
            break;
          }
          close = next + 1;
        }
        if (found > 0) {
          const children = parseInline(text.slice(run - (width - wanted), found));
          const leading = width - wanted > 0 ? char.repeat(width - wanted) : '';
          pushText(out, leading);
          const node: Inline =
            char === '~'
              ? { t: 'del', c: children }
              : wanted === 2
                ? { t: 'strong', c: children }
                : { t: 'em', c: children };
          out.push(node);
          at = found + wanted;
          continue;
        }
      }
      pushText(out, text.slice(at, run));
      at = run;
      continue;
    }
    // Plain text up to the next character that could start something.
    let next = at + 1;
    while (next < length && !'\\\n`[!<*_~hH'.includes(text[next]!)) next++;
    pushText(out, text.slice(at, next));
    at = next;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-*+])[ \t]+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function alignOf(cell: string): 'left' | 'center' | 'right' | '' {
  const text = cell.trim();
  const left = text.startsWith(':');
  const right = text.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
}

/** The language word of a code fence: letters, digits and a few signs, never anything else. */
function languageOf(raw: string): string {
  return /^[\w+#.-]{1,24}$/.test(raw) ? raw.toLowerCase() : '';
}

/** Whether a line starts something that ends a paragraph. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (!line.trim()) {
      at++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      at++;
      let closed = false;
      while (at < lines.length) {
        const candidate = lines[at]!;
        const end = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
        if (end.test(candidate)) {
          closed = true;
          at++;
          break;
        }
        body.push(candidate);
        at++;
      }
      blocks.push({ t: 'code', lang: languageOf(fence[2] ?? ''), v: body.join('\n'), open: !closed });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1]!.length, c: parseInline(heading[2]!) });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: 'hr' });
      at++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at]!)) {
        inner.push(QUOTE.exec(lines[at]!)![1]!);
        at++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(inner.join('\n')) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const items: Block[][] = [];
      const first = ordered ? Number(ordered[2]) : 1;
      while (at < lines.length) {
        const here = lines[at]!;
        const marker = isOrdered ? ORDERED.exec(here) : BULLET.exec(here);
        if (!marker) break;
        const indent = marker[1]!.length;
        const content = marker[3]!;
        // Everything indented under the marker belongs to the item.
        const width = indent + (isOrdered ? marker[2]!.length + 2 : 2);
        const own: string[] = [content];
        at++;
        while (at < lines.length) {
          const next = lines[at]!;
          if (!next.trim()) {
            // A blank line stays in the item only if more of it follows, indented.
            const after = lines[at + 1];
            if (after !== undefined && /^\s/.test(after) && after.trim()) {
              own.push('');
              at++;
              continue;
            }
            break;
          }
          if (/^\s+\S/.test(next) && next.search(/\S/) >= Math.min(width, 2)) {
            own.push(next.slice(Math.min(next.search(/\S/), width)));
            at++;
            continue;
          }
          // A line that continues the item's paragraph, with no marker of its own.
          if (!startsBlock(next) && own.length > 0 && own[own.length - 1] !== '') {
            own.push(next);
            at++;
            continue;
          }
          break;
        }
        items.push(parseBlocks(own.join('\n')));
        if (at < lines.length && !lines[at]!.trim() && !(isOrdered ? ORDERED : BULLET).test(lines[at + 1] ?? '')) {
          break;
        }
        while (at < lines.length && !lines[at]!.trim() && (isOrdered ? ORDERED : BULLET).test(lines[at + 1] ?? '')) {
          at++;
        }
      }
      blocks.push({ t: 'list', ordered: isOrdered, start: first, items });
      continue;
    }
    const nextLine = lines[at + 1];
    if (
      line.includes('|') &&
      nextLine !== undefined &&
      TABLE_RULE.test(nextLine) &&
      cells(line).length === cells(nextLine).length
    ) {
      const head = cells(line).map(parseInline);
      const align = cells(nextLine).map(alignOf);
      const rows: Inline[][][] = [];
      at += 2;
      while (at < lines.length && lines[at]!.trim() && lines[at]!.includes('|')) {
        const row = cells(lines[at]!).map(parseInline);
        while (row.length < head.length) row.push([]);
        rows.push(row.slice(0, head.length));
        at++;
      }
      blocks.push({ t: 'table', head, rows, align });
      continue;
    }
    const paragraph: string[] = [line];
    at++;
    while (at < lines.length && lines[at]!.trim() && !startsBlock(lines[at]!)) {
      paragraph.push(lines[at]!);
      at++;
    }
    blocks.push({ t: 'p', c: parseInline(paragraph.join('\n').replace(/[ \t]+\n/g, '\n')) });
  }
  return blocks;
}
