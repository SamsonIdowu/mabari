// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, safeHref, type Block, type Inline } from './markdown.ts';

function text(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
        case 'code':
          return node.v;
        case 'br':
          return '\n';
        default:
          return text(node.c);
      }
    })
    .join('');
}

/** Every link in a tree of blocks, wherever it is. */
function links(blocks: Block[]): string[] {
  const found: string[] = [];
  const inlines = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.t === 'link') found.push(node.href);
      if ('c' in node) inlines(node.c);
    }
  };
  const walk = (block: Block) => {
    if ('c' in block && block.t !== 'quote') inlines(block.c as Inline[]);
    if (block.t === 'quote') block.c.forEach(walk);
    if (block.t === 'list') block.items.forEach((item) => item.forEach(walk));
    if (block.t === 'table') {
      block.head.forEach(inlines);
      block.rows.forEach((row) => row.forEach(inlines));
    }
  };
  blocks.forEach(walk);
  return found;
}

describe('safeHref', () => {
  it('lets web and mail addresses through, normalised', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('HTTP://EXAMPLE.com')).toBe('http://example.com/');
    expect(safeHref('mailto:me@example.com')).toBe('mailto:me@example.com');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'jav&#x61;script:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/x',
    '//evil.example.com/x',
    '/api/wipe',
    '#office?agent=a1',
    'ftp://example.com/x',
    '',
    'https://exa mple.com',
    'https://example.com/\u0000',
  ])('refuses %j', (address) => {
    expect(safeHref(address)).toBeNull();
  });
});

describe('inline', () => {
  it('reads emphasis, strong, code and strikethrough', () => {
    expect(parseInline('a **b** *c* `d` ~~e~~')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'd' },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'e' }] },
    ]);
  });

  it('leaves what looks like emphasis but is not', () => {
    expect(text(parseInline('snake_case_name and a_b_c'))).toBe('snake_case_name and a_b_c');
    expect(parseInline('*.ts and *.js')).toEqual([{ t: 'text', v: '*.ts and *.js' }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', v: '2 * 3 * 4' }]);
    expect(parseInline('half **written')).toEqual([{ t: 'text', v: 'half **written' }]);
    expect(parseInline('a `b')).toEqual([{ t: 'text', v: 'a `b' }]);
  });

  it('keeps code exactly, with no emphasis inside', () => {
    expect(parseInline('`a **b** <b>`')).toEqual([{ t: 'code', v: 'a **b** <b>' }]);
    expect(parseInline('``a ` b``')).toEqual([{ t: 'code', v: 'a ` b' }]);
  });

  it('honours a backslash before punctuation', () => {
    expect(parseInline('\\*not bold\\*')).toEqual([{ t: 'text', v: '*not bold*' }]);
  });

  it('turns a newline into a line break', () => {
    expect(parseInline('a\nb')).toEqual([{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }]);
  });

  it('links, and only to safe places', () => {
    expect(parseInline('[docs](https://example.com/docs)')).toEqual([
      { t: 'link', href: 'https://example.com/docs', c: [{ t: 'text', v: 'docs' }] },
    ]);
    // A link that can't be followed is its words.
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ t: 'text', v: 'click' }]);
    expect(parseInline('[click](data:text/html;base64,AAAA)')).toEqual([{ t: 'text', v: 'click' }]);
    expect(parseInline('[click](/api/wipe)')).toEqual([{ t: 'text', v: 'click' }]);
    expect(parseInline('[a](https://x.com/a_(b))')[0]).toMatchObject({ href: 'https://x.com/a_(b)' });
  });

  it('never loads an image: it is a link, or its words', () => {
    expect(parseInline('![chart](https://example.com/c.png)')).toEqual([
      { t: 'link', href: 'https://example.com/c.png', c: [{ t: 'text', v: 'chart' }] },
    ]);
    expect(parseInline('![x](javascript:alert(1))')).toEqual([{ t: 'text', v: 'x' }]);
    expect(parseInline('![](https://example.com/c.png)')[0]).toMatchObject({ t: 'link' });
  });

  it('links a bare address without its closing punctuation', () => {
    expect(parseInline('see https://example.com/a, and (https://example.com/b).')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/a', c: [{ t: 'text', v: 'https://example.com/a' }] },
      { t: 'text', v: ', and (' },
      { t: 'link', href: 'https://example.com/b', c: [{ t: 'text', v: 'https://example.com/b' }] },
      { t: 'text', v: ').' },
    ]);
    expect(links(parseBlocks('<https://example.com/x>'))).toEqual(['https://example.com/x']);
  });

  it('leaves raw HTML as text', () => {
    const nodes = parseInline('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>hi</b>');
    expect(nodes.every((node) => node.t === 'text' || node.t === 'br')).toBe(true);
    expect(text(nodes)).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>hi</b>');
  });

  it('does not link a scheme hidden in an autolink', () => {
    expect(links(parseBlocks('<javascript:alert(1)>'))).toEqual([]);
    expect(links(parseBlocks('<mailto:a@b.co>'))).toEqual(['mailto:a@b.co']);
  });
});

describe('blocks', () => {
  it('reads headings, paragraphs and rules', () => {
    expect(parseBlocks('# One\n\ntext here\nmore\n\n---\n\n###### Six')).toEqual([
      { t: 'h', level: 1, c: [{ t: 'text', v: 'One' }] },
      { t: 'p', c: [{ t: 'text', v: 'text here' }, { t: 'br' }, { t: 'text', v: 'more' }] },
      { t: 'hr' },
      { t: 'h', level: 6, c: [{ t: 'text', v: 'Six' }] },
    ]);
    // Seven hashes is not a heading.
    expect(parseBlocks('####### no')[0]).toMatchObject({ t: 'p' });
  });

  it('reads a fenced block, with its language', () => {
    expect(parseBlocks('```ts\nconst a = 1;\n\nconst b = 2;\n```\nafter')).toEqual([
      { t: 'code', lang: 'ts', v: 'const a = 1;\n\nconst b = 2;', open: false },
      { t: 'p', c: [{ t: 'text', v: 'after' }] },
    ]);
    expect(parseBlocks('~~~\n```\nnot a close\n~~~')[0]).toMatchObject({ v: '```\nnot a close' });
    expect(parseBlocks('````\n```\ninside\n```\n````')[0]).toMatchObject({ v: '```\ninside\n```' });
  });

  it('keeps a fence still being written open, with what has come', () => {
    expect(parseBlocks('here:\n\n```python\nprint(1)')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'here:' }] },
      { t: 'code', lang: 'python', v: 'print(1)', open: true },
    ]);
  });

  it('takes only a plain word as a fence language', () => {
    const lang = (info: string) => (parseBlocks(`\`\`\`${info}\nx\n\`\`\``)[0] as { lang: string }).lang;
    expect(lang('js onload=alert(1)')).toBe('js');
    expect(lang('<img')).toBe('');
    expect(lang('"><script>')).toBe('');
    expect(lang('C++')).toBe('c++');
  });

  it('reads lists, nested and numbered', () => {
    const [list] = parseBlocks('- one\n- two\n  - inner\n  - inner two\n- three');
    expect(list).toMatchObject({ t: 'list', ordered: false });
    const items = (list as Extract<Block, { t: 'list' }>).items;
    expect(items).toHaveLength(3);
    expect(items[1]![1]).toMatchObject({ t: 'list', items: [[{ t: 'p' }], [{ t: 'p' }]] });
    const [numbered] = parseBlocks('3. c\n4. d');
    expect(numbered).toMatchObject({ t: 'list', ordered: true, start: 3 });
    expect((numbered as Extract<Block, { t: 'list' }>).items).toHaveLength(2);
  });

  it('keeps a list through blank lines between its items', () => {
    const [list] = parseBlocks('- a\n\n- b\n\n- c');
    expect((list as Extract<Block, { t: 'list' }>).items).toHaveLength(3);
  });

  it('puts a code block inside a list item', () => {
    const [list] = parseBlocks('1. run:\n\n   ```sh\n   make test\n   ```\n2. done');
    const items = (list as Extract<Block, { t: 'list' }>).items;
    expect(items).toHaveLength(2);
    expect(items[0]!.some((block) => block.t === 'code' && block.v === 'make test')).toBe(true);
  });

  it('reads a quotation', () => {
    expect(parseBlocks('> a\n> b\n\nc')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }] }] },
      { t: 'p', c: [{ t: 'text', v: 'c' }] },
    ]);
  });

  it('reads a table with its alignment', () => {
    const [table] = parseBlocks('| Name | Count |\n|:--|--:|\n| a | 1 |\n| b \\| c | 2 |');
    expect(table).toMatchObject({ t: 'table', align: ['left', 'right'] });
    const { head, rows } = table as Extract<Block, { t: 'table' }>;
    expect(head.map(text)).toEqual(['Name', 'Count']);
    expect(rows.map((row) => row.map(text))).toEqual([
      ['a', '1'],
      ['b | c', '2'],
    ]);
  });

  it('is not a table without its rule line', () => {
    expect(parseBlocks('a | b\nc | d')[0]).toMatchObject({ t: 'p' });
  });

  it('copes with windows line ends and a blank message', () => {
    expect(parseBlocks('a\r\n\r\nb')).toHaveLength(2);
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\n\n  \n')).toEqual([]);
  });

  it('keeps a hostile message as text, with no link that can run', () => {
    const hostile = [
      '# <img src=x onerror=alert(1)>',
      '',
      '[a](javascript:alert(document.cookie)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,x)',
      '<script>alert(1)</script>',
      '',
      '```html',
      '<script>alert(1)</script>',
      '```',
      '',
      '![](javascript:alert(1)) <javascript:alert(1)> https://ok.example.com/path',
      '',
      '| a |',
      '|---|',
      '| [x](vbscript:y) |',
    ].join('\n');
    expect(links(parseBlocks(hostile))).toEqual(['https://ok.example.com/path']);
  });

  it('never throws, and only ever links safely, whatever it is given', () => {
    const pieces = ['[', ']', '(', ')', '`', '*', '_', '~', '<', '>', '!', '\\', '\n', '#', '-', '|', ' ', 'a', 'http://x.co', 'javascript:', '```'];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 400; round++) {
      let source = '';
      for (let count = next() % 40; count > 0; count--) source += pieces[next() % pieces.length];
      const blocks = parseBlocks(source);
      for (const href of links(blocks)) expect(safeHref(href)).not.toBeNull();
    }
  });

  it('reads a long message in a moment', () => {
    const source = Array.from({ length: 4000 }, (_, i) => `- item **${i}** with \`code\` and [a link](https://example.com/${i})`).join('\n');
    const started = performance.now();
    const [list] = parseBlocks(source);
    expect((list as Extract<Block, { t: 'list' }>).items).toHaveLength(4000);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
