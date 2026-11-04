// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import type { ServerMessage } from '../gen/models.ts';
import { api } from './api.ts';
import { useOfficeStore } from './officeStore.ts';

const RETRY_MS = 1000;

/** Keeps the store current: a snapshot first, then numbered changes over the WebSocket. */
export function useOfficeSync(): void {
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const { setSnapshot, apply } = useOfficeStore.getState();

    const reload = async () => {
      const snapshot = await api.snapshot();
      if (!stopped) setSnapshot(snapshot);
    };

    const connect = () => {
      const office = useOfficeStore.getState().office;
      const resume = office ? `?boot=${office.bootId}&since=${office.seq}` : '';
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws${resume}`);
      socket.onmessage = (incoming: MessageEvent<string>) => {
        const message = JSON.parse(incoming.data) as ServerMessage;
        if (message.type === 'hello') return;
        if (message.type === 'resync' || message.type === 'reset') {
          void reload().catch(() => undefined);
          return;
        }
        apply(message);
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
      socket?.close();
    };
  }, []);
}
