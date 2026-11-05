// SPDX-License-Identifier: Apache-2.0
// The agent builder's page state, and Mabari's two skills, which fill in the build dialog for the
// person to check. Home uses them too, for "improve <agent>" and "create an agent that …".
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { useOfficeStore } from '../data/officeStore.ts';
import type { AgentDef, LiveAgent } from '../gen/models.ts';
import { blankDef, draftFrom, improve } from './defs.ts';

/** The build or edit dialog, and Mabari's note when it suggested what is in it. */
export interface DefDialog {
  /** The definition being edited, or empty for a new one. */
  id: string;
  edit: AgentDef;
  /** Mabari filled it in: a draft or suggested improvements. */
  by: 'mabari' | '';
  note: ReactNode;
}

interface BuilderUi {
  filter: string;
  query: string;
  open: string | null;
  deleting: string | null;
  dialog: DefDialog | null;
  set: (patch: Partial<Omit<BuilderUi, 'set'>>) => void;
}

export const useBuilder = create<BuilderUi>((set) => ({
  filter: 'all',
  query: '',
  open: null,
  deleting: null,
  dialog: null,
  set: (patch) => set(patch),
}));

export function running(agents: LiveAgent[], def: AgentDef) {
  return agents.filter((agent) => agent.defId === def.id);
}

function goToBuilder() {
  if (window.location.hash !== '#builder') window.location.hash = '#builder';
}

/** Opens the builder with one agent's tile open, as when it is clicked in the lounge. */
export function openDef(id: string) {
  useBuilder.getState().set({ open: id, filter: 'all', query: '' });
  goToBuilder();
}

/** Mabari's agent-creator skill: opens the build dialog with a draft, or asks what to draft. */
export function mabariCreate(text: string) {
  goToBuilder();
  const defs = useOfficeStore.getState().office?.defs ?? [];
  const edit = blankDef(defs.length);
  let note: ReactNode = (
    <>
      <b>Tell me what the agent should do</b> and press Draft. I&apos;ll fill in the rest.
    </>
  );
  if (text.trim()) {
    const draft = draftFrom(text);
    Object.assign(edit, {
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      tools: draft.tools,
    });
    note = (
      <>
        <b>I drafted {draft.name} with my agent creator skill.</b> Check the instructions and tools,
        then save it.
      </>
    );
  }
  useBuilder.getState().set({ dialog: { id: '', edit, by: 'mabari', note } });
  return edit.name;
}

/** Mabari's agent-improver skill: opens the edit dialog with suggested changes listed on top. */
export function mabariImprove(idOrName: string): { name: string; changes: number } | null {
  const office = useOfficeStore.getState().office;
  const def = office?.defs.find((item) => item.id === idOrName || item.name === idOrName);
  if (!office || !def || def.system) return null;
  goToBuilder();
  const { def: edit, changes } = improve(def, running(office.agents, def));
  const note = changes.length ? (
    <>
      <b>
        I suggest {changes.length} change{changes.length === 1 ? '' : 's'} to {def.name}:
      </b>
      <ul>
        {changes.map((change) => (
          <li key={change}>{change}</li>
        ))}
      </ul>
      Review them below, then save.
    </>
  ) : (
    <>
      <b>{def.name} already looks solid.</b> I found nothing to change. Edit anything you like and
      save.
    </>
  );
  useBuilder.getState().set({ dialog: { id: def.id, edit, by: 'mabari', note } });
  return { name: def.name, changes: changes.length };
}
