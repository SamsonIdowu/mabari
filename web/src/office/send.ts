// SPDX-License-Identifier: Apache-2.0
import { api, type MessageMode, type MessageResult } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Snapshot } from '../gen/models.ts';
import { useOfficeUi } from './uiStore.ts';

/** Puts an answer where the user will look for it. */
export function showResult(result: MessageResult, question: string) {
  const ui = useOfficeUi.getState();
  if (result.answer) {
    ui.set({
      selected: result.answer.agentId,
      panelTab: 'live',
      answers: { ...ui.answers, [result.answer.agentId]: result.answer },
    });
  }
  if (result.team) ui.set({ teamAnswer: { question, lines: result.team } });
}

/** Sends a message and shows what came back. The panel and the command bar both use this. */
export async function send(
  text: string,
  mode: MessageMode,
  target: string,
  office: Snapshot,
): Promise<void> {
  const ui = useOfficeUi.getState();
  try {
    const scope = { projectId: ui.project, teamId: ui.team ?? '' };
    const result = await api.sendMessage(text, mode, target, scope);
    const [first] = result.agents;
    if (result.routed && first) {
      const agent = office.agents.find((item) => item.id === first);
      if (agent?.state !== 'approval') ui.set({ selected: first, target: 'selected' });
    }
    showResult(result, text);
  } catch (error) {
    useOfficeStore.getState().toast((error as Error).message);
  }
}
