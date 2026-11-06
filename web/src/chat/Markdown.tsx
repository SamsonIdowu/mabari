// SPDX-License-Identifier: Apache-2.0
import { Fragment, memo, useMemo, useState, type ReactNode } from 'react';
import { copyText } from './copy.ts';
import { parseBlocks, type Block, type Inline } from './markdown.ts';

function Spans({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.t) {
      case 'text':
        return <Fragment key={index}>{node.v}</Fragment>;
      case 'br':
        return <br key={index} />;
      case 'code':
        return <code key={index}>{node.v}</code>;
      case 'strong':
        return (
          <strong key={index}>
            <Spans nodes={node.c} />
          </strong>
        );
      case 'em':
        return (
          <em key={index}>
            <Spans nodes={node.c} />
          </em>
        );
      case 'del':
        return (
          <del key={index}>
            <Spans nodes={node.c} />
          </del>
        );
      case 'link':
        // The address is shown on hover, since the words can say anything. It opens in a new tab
        // with no way back to this one.
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={node.href}
          >
            <Spans nodes={node.c} />
          </a>
        );
    }
  });
}

function CodeBlock({ lang, code, open }: { lang: string; code: string; open: boolean }) {
  const [copied, setCopied] = useState(false);
  const name = lang || 'code';
  return (
    <figure className="mdcode">
      <figcaption>
        <span className="mdlang">{name}</span>
        <button
          type="button"
          className="btn ghost sm"
          aria-label={`Copy this ${name} block`}
          onClick={() => {
            copyText(code, 'Code copied');
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={`${name} code`}>
        <code>{code}</code>
        {open ? <span className="mdcaret" aria-hidden="true" /> : null}
      </pre>
    </figure>
  );
}

function Blocks({ blocks }: { blocks: Block[] }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.t) {
      case 'p':
        return (
          <p key={index}>
            <Spans nodes={block.c} />
          </p>
        );
      case 'h': {
        // Headings in a message are bold lines, not a new outline for the page.
        const level = Math.min(block.level + 2, 6);
        const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
        return (
          <Tag key={index} className="mdh">
            <Spans nodes={block.c} />
          </Tag>
        );
      }
      case 'code':
        return <CodeBlock key={index} lang={block.lang} code={block.v} open={block.open} />;
      case 'hr':
        return <hr key={index} />;
      case 'quote':
        return (
          <blockquote key={index}>
            <Blocks blocks={block.c} />
          </blockquote>
        );
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag key={index} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
            {block.items.map((item, at) => (
              <li key={at}>
                <Blocks blocks={item} />
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div className="mdtable" key={index} tabIndex={0} role="region" aria-label="Table">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, at) => (
                    <th
                      key={at}
                      style={block.align[at] ? { textAlign: block.align[at] } : undefined}
                    >
                      <Spans nodes={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, at) => (
                  <tr key={at}>
                    {row.map((cell, column) => (
                      <td
                        key={column}
                        style={block.align[column] ? { textAlign: block.align[column] } : undefined}
                      >
                        <Spans nodes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/**
 * An agent's words, drawn from a tree the page owns. Nothing here sets HTML from text, so a
 * message can't add a tag, an attribute or a script, and a link can only go to a web or mail
 * address. While the text is still arriving, a caret shows where it is.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={streaming ? 'md streaming' : 'md'}>
      <Blocks blocks={blocks} />
      {streaming && (blocks.length === 0 || blocks[blocks.length - 1]?.t !== 'code') ? (
        <span className="mdcaret" aria-hidden="true" />
      ) : null}
    </div>
  );
});
