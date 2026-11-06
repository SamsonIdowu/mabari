// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import type { ServerMessage } from '../gen/models.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { useVee } from '../office/veeStore.ts';
import { useVoice } from '../office/voiceStore.ts';
import { api } from './api.ts';
import { useAsks } from './chatApi.ts';
import { useConversations } from './conversation.ts';
import { flushBeforeInput, frameBatch } from './frameBatch.ts';
import { holdChangesWith } from './heldChanges.ts';
import { useOfficeStore } from './officeStore.ts';
import { reloader } from './reloader.ts';
import { socketProtocols } from './session.ts';

const RETRY_MS = 1000;

/** Forgets what the page was showing, because the office it showed was wiped or replaced. */
function forgetView() {
  useOfficeUi.getState().resetOffice();
  useVee.getState().reset();
  useVoice.getState().cancel();
}

/** Keeps the store current: a snapshot first, then numbered changes over the WebSocket. */
export function useOfficeSync(): void {
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let reloadRetry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const { setSnapshot, applyAll } = useOfficeStore.getState();
    // Changes that arrive in the same frame are applied together, so a burst of them costs the
    // page one render, not one each.
    const arrived = frameBatch<ServerMessage>(applyAll);
    const release = holdChangesWith(arrived.flush);
    // Nothing a person does acts on an office that is a frame behind.
    const stopInputFlush = flushBeforeInput(arrived);

    // Messages that arrive while a snapshot is loading wait in the reloader. Those newer than the
    // snapshot are applied after it, so nothing is lost or applied twice, even when reloads overlap.
    const { reload, hold } = reloader({
      snapshot: api.snapshot,
      setSnapshot,
      applyAll,
      // What came before the snapshot was asked for goes in first, in order.
      flush: arrived.flush,
      stopped: () => stopped,
    });

    const reloadUntilItWorks = () => {
      reload().catch(() => {
        if (!stopped) reloadRetry = setTimeout(reloadUntilItWorks, RETRY_MS);
      });
    };

    const connect = () => {
      const office = useOfficeStore.getState().office;
      const resume = office ? `?boot=${office.bootId}&since=${office.seq}` : '';
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${protocol}://${window.location.host}/ws${resume}`,
        socketProtocols(),
      );
      socket.onmessage = (incoming: MessageEvent<string>) => {
        const message = JSON.parse(incoming.data) as ServerMessage;
        if (message.type === 'hello') return;
        if (message.type === 'resync' || message.type === 'reset') {
          // What is held is older than this message, so it counts as seen.
          arrived.flush();
          const seen = useOfficeStore.getState().office?.seq ?? 0;
          // A snapshot loaded after this message already includes it.
          if (message.seq !== 0 && message.seq <= seen) return;
          if (message.type === 'reset') forgetView();
          reloadUntilItWorks();
          // Conversations aren't in the snapshot, so what is open reloads by itself.
          useConversations.getState().reloadAll();
          useAsks.getState().reload();
          return;
        }
        // Not batched: text streaming a word at a time should show as it arrives.
        useConversations.getState().apply(message);
        if (!hold(message)) arrived.add(message);
      };
      socket.onclose = () => {
        // The next connection resumes from what the office holds, so hand over what is waiting.
        arrived.flush();
        if (!stopped) retry = setTimeout(connect, RETRY_MS);
      };
    };

    // The snapshot comes first, so nothing streamed is applied to an empty office.
    const start = () => {
      reload()
        .then(() => {
          if (!stopped) connect();
        })
        .catch(() => {
          if (!stopped) retry = setTimeout(start, RETRY_MS);
        });
    };
    start();

    return () => {
      stopped = true;
      release();
      stopInputFlush();
      arrived.discard();
      clearTimeout(retry);
      clearTimeout(reloadRetry);
      socket?.close();
    };
  }, []);
}
