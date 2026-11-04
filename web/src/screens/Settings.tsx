// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Settings as SettingsModel, Snapshot } from '../gen/models.ts';
import { playDing } from '../office/ding.ts';
import { Icon } from '../shell/Icon.tsx';
import { AutoApproveButton, AutoApproveDialog } from './Approvals.tsx';
import { PageHead } from './parts.tsx';

const DEFAULTS: [key: string, label: string, kind: string][] = [
  ['claude', 'Claude Code', 'claude_code'],
  ['codex', 'ChatGPT (Codex)', 'codex'],
  ['anthropic', 'Anthropic API key', 'anthropic_key'],
  ['openai', 'OpenAI API key', 'openai_key'],
];

const save = (patch: Partial<SettingsModel>) => {
  api.updateSettings(patch).catch((error: Error) => {
    useOfficeStore.getState().toast(error.message);
  });
};

function connectedModels(office: Snapshot): string[] {
  const models = office.accounts
    .filter((account) => account.status === 'connected')
    .flatMap((account) => account.models);
  return [...new Set(models)];
}

function QueryCard({ office }: { office: Snapshot }) {
  const models = connectedModels(office);
  return (
    <div className="card">
      <h2>Answering queries</h2>
      <div className="kv">
        <label className="flabel" htmlFor="pQuery">
          Model that answers queries
        </label>
        <div className="field">
          <select
            className="in"
            id="pQuery"
            style={{ maxWidth: 360 }}
            disabled={models.length === 0}
            value={
              models.includes(office.settings.queryModel)
                ? office.settings.queryModel
                : (models[0] ?? '')
            }
            onChange={(event) => save({ queryModel: event.target.value })}
          >
            {models.length ? (
              models.map((model) => <option key={model}>{model}</option>)
            ) : (
              <option value="">Connect an account first</option>
            )}
          </select>
          <span className="help">
            Queries are answered from Mabari&apos;s own log, so they never interrupt an agent. A
            small, fast model is usually enough.
          </span>
        </div>
      </div>
    </div>
  );
}

function DefaultsCard({ office }: { office: Snapshot }) {
  const { defaults } = office.settings;
  return (
    <div className="card">
      <h2>Agent defaults</h2>
      <p className="help">
        New agents take their model from here unless you pick one. Each agent&apos;s own settings
        decide the model its subagents use.
      </p>
      <div className="kv">
        {DEFAULTS.map(([key, label, kind]) => [
          <label className="flabel" htmlFor={`def-${key}`} key={`${key}-label`}>
            {label}
          </label>,
          <select
            className="in"
            id={`def-${key}`}
            key={key}
            style={{ maxWidth: 320 }}
            value={defaults[key] ?? ''}
            onChange={(event) => save({ defaults: { ...defaults, [key]: event.target.value } })}
          >
            {office.accounts
              .find((account) => account.kind === kind)
              ?.models.map((model) => (
                <option key={model}>{model}</option>
              ))}
          </select>,
        ])}
      </div>
    </div>
  );
}

function ApprovalsCard({ settings }: { settings: SettingsModel }) {
  const { on, scope } = settings.autoApprove;
  const state = !on
    ? 'Off. Agents ask before running commands or changing files outside their folder.'
    : scope === 'all'
      ? 'On for everything, including risky actions.'
      : 'On for low risk actions. Risky actions still wait for you.';
  return (
    <div className="card">
      <h2>Approvals</h2>
      <div className="kv">
        <span className="flabel">Auto approve</span>
        <div className="field">
          <AutoApproveButton settings={settings} extraStyle={{ alignSelf: 'flex-start' }} />
          <span className="help">
            {state} Applies to all agents and is recorded in the Activity log.
          </span>
        </div>
      </div>
    </div>
  );
}

const GB = 1e9;

/**
 * Local Whisper set-up. whisper.cpp is the person's own install; Mabari downloads the model only
 * when the button is clicked, and checks it against its published checksum.
 */
function WhisperSetup() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['whisper'],
    queryFn: api.whisperStatus,
    refetchInterval: (query) => (query.state.data?.downloading ? 1000 : false),
  });
  const act = (call: () => Promise<unknown>) =>
    call()
      .catch((error: Error) => useOfficeStore.getState().toast(error.message))
      .finally(() => void queryClient.invalidateQueries({ queryKey: ['whisper'] }));
  const whisper = status.data;
  if (!whisper) return null;
  const size = `${(whisper.total / GB).toFixed(1)} GB`;
  return (
    <div className="help" id="whisperSetup" style={{ marginLeft: 26, display: 'grid', gap: 8 }}>
      {whisper.installed ? null : (
        <span>
          Install whisper.cpp first, for example with <code>brew install whisper-cpp</code>. Mabari
          looks for its <code>whisper-cli</code> tool.
        </span>
      )}
      {whisper.downloading ? (
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          Downloading the model… {Math.floor((whisper.done / whisper.total) * 100)}%
          <button type="button" className="btn ghost" onClick={() => void act(api.removeWhisper)}>
            Cancel
          </button>
        </span>
      ) : whisper.ready ? (
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {whisper.installed ? 'Ready. Your voice stays on this computer.' : 'Model downloaded.'}
          <button type="button" className="btn ghost" onClick={() => void act(api.removeWhisper)}>
            Remove the model
          </button>
        </span>
      ) : (
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => void act(api.downloadWhisper)}>
            Download the model ({size})
          </button>
          From Hugging Face, checked against its published checksum.
        </span>
      )}
      {whisper.error ? <span style={{ color: 'var(--red)' }}>{whisper.error}</span> : null}
    </div>
  );
}

function VoiceCard({ settings }: { settings: SettingsModel }) {
  return (
    <div className="card">
      <h2>Voice</h2>
      <div className="kv">
        <span className="flabel">Voice engine</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 520 }}>
          <label className="radio">
            <input
              type="radio"
              name="voice"
              checked={settings.voiceEngine === 'browser'}
              onChange={() => save({ voiceEngine: 'browser' })}
            />
            <span>
              <b>Browser, on device</b>
              <br />
              <span className="help">
                Uses your browser&apos;s built in speech recognition. Nothing to install.
              </span>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="voice"
              checked={settings.voiceEngine === 'whisper'}
              onChange={() => save({ voiceEngine: 'whisper' })}
            />
            <span>
              <b>Local Whisper</b>
              <br />
              <span className="help">
                Runs a Whisper model on this computer. More accurate, needs about 1.5 GB.
              </span>
            </span>
          </label>
          {settings.voiceEngine === 'whisper' ? <WhisperSetup /> : null}
        </div>
        <span className="flabel">Spoken replies</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.spokenReplies}
            onChange={(event) => save({ spokenReplies: event.target.checked })}
          />
          Read agent replies aloud
        </label>
        <span className="flabel">Sounds</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.completionSound}
              onChange={(event) => save({ completionSound: event.target.checked })}
            />
            Ding when a task is completed
          </label>
          <button type="button" className="btn sm" onClick={playDing}>
            Play it
          </button>
        </div>
      </div>
    </div>
  );
}

function DataCard({ settings }: { settings: SettingsModel }) {
  return (
    <div className="card">
      <h2>Data</h2>
      <div className="kv">
        <label className="flabel" htmlFor="pRet">
          Keep events for
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            className="in"
            id="pRet"
            style={{ width: 'auto' }}
            value={settings.retentionDays}
            onChange={(event) => save({ retentionDays: Number(event.target.value) })}
          >
            {[7, 30, 90, 365].map((days) => (
              <option value={days} key={days}>
                {days} days
              </option>
            ))}
          </select>
          <span className="help">Older tool calls and log entries are deleted automatically.</span>
        </div>
        <span className="flabel">LAN access</span>
        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              id="pLan"
              checked={settings.lanAccess}
              onChange={(event) => save({ lanAccess: event.target.checked })}
            />
            Allow other devices on my network
          </label>
          {settings.lanAccess ? (
            <div className="banner amber" style={{ padding: '10px 12px' }}>
              <Icon>
                <path d="M12 8v5M12 16h.01" />
              </Icon>
              <span className="grow">
                Anyone on your network who can reach this computer on port <code>4317</code> can see
                your agents and send them instructions. Turn this off on shared or public networks.
              </span>
            </div>
          ) : (
            <span className="help">Off. Mabari only answers on localhost.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function WipeCard() {
  const [confirming, setConfirming] = useState(false);
  const wipe = async () => {
    await api.wipe();
    setConfirming(false);
    window.location.hash = '#welcome';
    useOfficeStore.getState().toast('All data wiped');
  };
  return (
    <div className="card" style={{ borderColor: 'var(--red)' }}>
      <h2>Wipe all data</h2>
      <p className="muted">
        Removes every account connection, token, API key, event and log entry, and restores your
        Claude Code settings from the backup. Your agents and their folders are not touched.
      </p>
      {confirming ? (
        <div className="banner red">
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">This cannot be undone. Wipe everything now?</span>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={() => void wipe()}>
            Yes, wipe all data
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className="btn danger-out" onClick={() => setConfirming(true)}>
            Wipe all data…
          </button>
        </div>
      )}
    </div>
  );
}

export function Settings() {
  const office = useOfficeStore((state) => state.office);
  if (!office) return null;
  return (
    <section data-screen="preferences">
      <div className="page">
        <PageHead title="Settings" description="Everything here stays on this computer." />
        <QueryCard office={office} />
        <DefaultsCard office={office} />
        <ApprovalsCard settings={office.settings} />
        <VoiceCard settings={office.settings} />
        <DataCard settings={office.settings} />
        <WipeCard />
      </div>
      <AutoApproveDialog office={office} />
    </section>
  );
}
