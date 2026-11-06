// SPDX-License-Identifier: Apache-2.0
import '@fontsource/nunito/500.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/shell.css';
import './styles/setup.css';
import './styles/calm.css';
import './styles/chat.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './shell/Shell.tsx';
import { SessionGate } from './shell/SignIn.tsx';
import { startViewState } from './viewState.ts';

// Mabari only talks to this computer, so a lost internet connection must not pause requests. If it
// did, the status dot could stay green after the local server stopped.
const queryClient = new QueryClient({
  defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// The office filters, the tabs, and the agent or chat named in the address come back after a reload.
startViewState();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionGate>
        <Shell />
      </SessionGate>
    </QueryClientProvider>
  </StrictMode>,
);
