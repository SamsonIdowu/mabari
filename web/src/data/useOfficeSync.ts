// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import type { ServerMessage } from '../gen/models.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { useVee } from '../office/veeStore.ts';
import { useVoice } from '../office/voiceStore.ts';
import { api } from './api.ts';
import { useOfficeStore } from './officeStore.ts';

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
    // Messages that arrive while a snapshot is loading wait here. Those newer than the snapshot
    // are applied after it, so nothing is lost or applied twice.
    let waiting: ServerMessage[] | null = null;
    const { setSnapshot, apply } = useOfficeStore.getState();

    const reload = async () => {
      waiting ??= [];
      try {
        const snapshot = await api.snapshot();
        if (stopped) return;
        setSnapshot(snapshot);
        for (const message of waiting) apply(message);
      } finally {
        waiting = null;
      }
    };

    const reloadUntilItWorks = () => {
      reload().catch(() => {
        if (!stopped) reloadRetry = setTimeout(reloadUntilItWorks, RETRY_MS);
      });
    };

    const connect = () => {
      const office = useOfficeStore.getState().office;
      const resume = office ? `?boot=${office.bootId}&since=${office.seq}` : '';
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws${resume}`);
      socket.onmessage = (incoming: MessageEvent<string>) => {
        const message = JSON.parse(incoming.data) as ServerMessage;
        if (message.type === 'hello') return;
        const seen = useOfficeStore.getState().office?.seq ?? 0;
        if (message.type === 'resync' || message.type === 'reset') {
          // A snapshot loaded after this message already includes it.
          if (message.seq !== 0 && message.seq <= seen) return;
          if (message.type === 'reset') forgetView();
          reloadUntilItWorks();
          return;
        }
        if (waiting) waiting.push(message);
        else apply(message);
      };
      socket.onclose = () => {
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
      clearTimeout(retry);
      clearTimeout(reloadRetry);
      socket?.close();
    };
  }, []);
}
