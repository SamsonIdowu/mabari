// SPDX-License-Identifier: Apache-2.0
// Mabari relays an agent's reply to what it was sent, and the prompt tray shows each prompt's
// progress. Both read the same server state: an agent's queued and asked instructions.
import type { Instruction, LiveAgent, Snapshot } from '../gen/models.ts';

/** What Mabari watches after passing an instruction on. Mirrors internal/vee.Relay. */
export interface Relay {
  /**
   * The agent that holds the instruction: the agent itself, or a Claude Code subagent's lead.
   * Empty while Claude Code is opening with it, until a session in the project takes it.
   */
  agentId: string;
  instructionId: string;
  /** Who answers and with which AI, for "Ledger (Claude) replied: …". */
  agent: string;
  ai: string;
}

/** How much of a reply the speech bubble shows. The whole reply is in the agent's panel. */
export const RELAY_SHOWN = 400;
/** How much of a reply is read aloud. */
export const RELAY_SPOKEN = 300;

/** The AI behind an agent, named as internal/models.AIName names it. */
export function aiName(agent: Pick<LiveAgent, 'account' | 'provider'>): string {
  if (agent.account === 'codex') return 'ChatGPT';
  if (agent.provider === 'claude') return 'Claude';
  if (agent.provider === 'openai') return 'OpenAI';
  return 'Custom AI';
}

/** Cuts text at a word near the limit, with an ellipsis, so it reads naturally. */
export function clipWords(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/** Who holds a relayed instruction now: its agent, or any agent once an opened session took it. */
function holderOf(office: Snapshot | null, relay: Relay): LiveAgent | undefined {
  const agents = office?.agents ?? [];
  if (relay.agentId) return agents.find((item) => item.id === relay.agentId);
  return agents.find((item) => item.asked?.some((asked) => asked.id === relay.instructionId));
}

/** The reply to a relayed instruction, once the agent has given one. */
export function replyFor(office: Snapshot | null, relay: Relay): Instruction | null {
  const asked = holderOf(office, relay)?.asked?.find((item) => item.id === relay.instructionId);
  return asked?.reply ? asked : null;
}

/**
 * False once nothing will ever answer: the instruction was taken back before delivery, or the
 * agent holding it has left.
 */
export function stillWaiting(office: Snapshot | null, relay: Relay): boolean {
  const id = relay.instructionId;
  const opening = office?.projects?.some((project) =>
    project.opening?.some((item) => item.id === id),
  );
  if (!relay.agentId) return !!opening || !!holderOf(office, relay);
  const agent = holderOf(office, relay);
  return (
    !!agent && [...(agent.queued ?? []), ...(agent.asked ?? [])].some((item) => item.id === id)
  );
}

export function relayLine(relay: Relay, reply: string) {
  const head = `${relay.agent} (${relay.ai}) replied: `;
  const shown = clipWords(reply, RELAY_SHOWN);
  return {
    text: head + shown,
    spoken: head + clipWords(reply, RELAY_SPOKEN),
    clipped: shown !== reply.replace(/\s+/g, ' ').trim(),
  };
}

export type PromptStatus = 'queued' | 'thinking' | 'replied';

export interface PromptCard {
  id: string;
  agentId: string;
  agentName: string;
  /** "Claude · claude-sonnet-4-5". */
  ai: string;
  provider: string;
  text: string;
  status: PromptStatus;
  reply: string;
  /** When it was sent, for ordering. */
  at: number;
}

/** A replied card stays this long, as in the prototype. */
export const REPLIED_SHOWN_MS = 14000;
/** A prompt still waiting for its reply stays on the tray this long. */
export const WAITING_SHOWN_MS = 15 * 60 * 1000;
const TRAY_SIZE = 3;

/** The newest prompts sent from Mabari, for the tray on the floor. */
export function promptCards(
  agents: LiveAgent[],
  now: number,
  dismissed: ReadonlySet<string>,
): PromptCard[] {
  const cards: PromptCard[] = [];
  for (const agent of agents) {
    const base = {
      agentId: agent.id,
      agentName: agent.name,
      ai: `${aiName(agent)} · ${agent.model}`,
      provider: agent.provider,
    };
    for (const item of agent.queued ?? []) {
      cards.push({
        ...base,
        id: item.id,
        text: item.text,
        status: 'queued',
        reply: '',
        at: item.time,
      });
    }
    for (const item of agent.asked ?? []) {
      if (item.reply) {
        if (now - item.repliedAt > REPLIED_SHOWN_MS) continue;
        cards.push({
          ...base,
          id: item.id,
          text: item.text,
          status: 'replied',
          reply: item.reply,
          at: item.time,
        });
      } else if (now - item.time < WAITING_SHOWN_MS) {
        cards.push({
          ...base,
          id: item.id,
          text: item.text,
          status: 'thinking',
          reply: '',
          at: item.time,
        });
      }
    }
  }
  return cards
    .filter((card) => !dismissed.has(card.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, TRAY_SIZE);
}
