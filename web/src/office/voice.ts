// SPDX-License-Identifier: Apache-2.0
import type { MessageMode } from '../data/api.ts';
import type { LiveAgent } from '../gen/models.ts';

const QUESTION = /^(what|what's|whats|how|when|why|who|where|which|is|are|did|does|has|have)\b/i;
const APPROVAL = /\b(allow|approve|accept|go ahead)\b/i;

export interface Heard {
  /** Who it is for. Null leaves it to the dispatcher. */
  agent: LiveAgent | null;
  mode: MessageMode;
  /** It sounds like an approval, which voice can never give. */
  approval: boolean;
}

function named(text: string, agents: LiveAgent[]): LiveAgent | null {
  const longestFirst = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const agent of longestFirst) {
    const name = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) return agent;
  }
  return null;
}

/** Works out who a spoken message is for and whether it instructs or asks. */
export function detect(text: string, agents: LiveAgent[], selected: LiveAgent | null): Heard {
  const agent = named(text, agents) ?? selected;
  const body = text.replace(/^[A-Za-z ]+,\s*/, '').trim();
  return {
    agent,
    mode: text.trim().endsWith('?') || QUESTION.test(body) ? 'query' : 'instruct',
    approval: APPROVAL.test(text),
  };
}
