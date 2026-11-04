// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { Answer } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';

/** Queries answered from the log, and the cards the user closed, for the prompt tray. */
export interface QueryCard {
  id: string;
  agentId: string;
  agentName: string;
  ai: string;
  provider: string;
  text: string;
  reply: string;
  at: number;
}

interface TrayStore {
  queries: QueryCard[];
  dismissed: Set<string>;
  asked: (answer: Answer, queryModel: string) => void;
  dismiss: (id: string) => void;
}

let nextQuery = 1;

export const usePromptTray = create<TrayStore>((set) => ({
  queries: [],
  dismissed: new Set(),
  asked: (answer, queryModel) => {
    const agent = useOfficeStore
      .getState()
      .office?.agents.find((item) => item.id === answer.agentId);
    const card: QueryCard = {
      id: `q${nextQuery++}`,
      agentId: answer.agentId,
      agentName: answer.name,
      ai: `${answer.answeredBy || queryModel} (query model)`,
      provider: agent?.provider ?? 'custom',
      text: answer.question,
      reply: answer.text || `${answer.state}: ${answer.task}.`,
      at: Date.now(),
    };
    set((state) => ({ queries: [card, ...state.queries].slice(0, 10) }));
  },
  dismiss: (id) => set((state) => ({ dismissed: new Set(state.dismissed).add(id) })),
}));
