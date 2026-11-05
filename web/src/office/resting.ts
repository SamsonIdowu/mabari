// SPDX-License-Identifier: Apache-2.0
import type { AgentDef } from '../gen/models.ts';
import { identityHues, type ProviderName } from '../shared/tokens.ts';

/** Skin tones and hair colours, as in internal/models/appearance.go. */
const SKINS = ['#F2C9A0', '#D9A27A', '#B07850', '#8C5A3A', '#6B4128', '#E8B98F'];
const HAIRS = ['#2A1B12', '#5A3A22', '#101010', '#B5651D', '#D9C27A', '#6B4E3A', '#2A2A2E'];

/** A small stable number from text, so an agent file always looks the same. */
export function stableHash(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * How an agent file resting in the lounge looks: its own colour, or a stable one from its id, the
 * shirt of the AI it runs on (orange for Claude, green for Codex), and skin and hair from its id.
 */
export function restingLook(def: AgentDef) {
  const hash = stableHash(def.id);
  const own = /^#[0-9a-f]{6}$/i.test(def.color) ? def.color : '';
  return {
    hue: own || identityHues[hash % identityHues.length]!,
    provider: (def.kind === 'codex' ? 'openai' : 'claude') as ProviderName,
    skin: SKINS[hash % SKINS.length]!,
    hair: HAIRS[(hash >>> 4) % HAIRS.length]!,
  };
}
