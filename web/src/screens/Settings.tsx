// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  ACCOUNT_LABEL,
  DEFAULTS_KEY,
  chooseableModels,
  connectedModels,
  modelOptions,
} from '../data/accountInfo.ts';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { AccountKind, Settings as SettingsModel, Snapshot } from '../gen/models.ts';
import { playDing } from '../office/ding.ts';
import { Icon } from '../shell/Icon.tsx';
import { useEscape } from '../shell/useEscape.ts';
import { AutoApproveButton, AutoApproveDialog } from './Approvals.tsx';
import { DemoNote } from './DemoNote.tsx';
import { NotifyRow } from './NotifyRow.tsx';
import { PageHead } from './parts.tsx';

/** The accounts whose default model can be set, in the order Settings lists them. */
const DEFAULT_KINDS: AccountKind[] = ['claude_code', 'codex', 'anthropic_key', 'openai_key'];

const SAVED_MS = 2200;
const useSaved = create<{ shown: boolean }>(() => ({ shown: false }));
let hideSaved: ReturnType<typeof setTimeout> | undefined;

/** Shows the quiet "Saved" for a moment, so a change that took effect can be told from one that didn't. */
function markSaved() {
  clearTimeout(hideSaved);
  useSaved.setState({ shown: true });
  hideSaved = setTimeout(() => useSaved.setState({ shown: false }), SAVED_MS);
}

/** Sits low on the page, whichever card was changed, and says nothing until something is stored. */
function SavedCue() {
  const shown = useSaved((state) => state.shown);
  return (
    <span id="savedCue" className={shown ? 'savedcue on' : 'savedcue'} role="status">
      {shown ? 'Saved' : ''}
    </span>
  );
}

const SESSION_CHOICES = [1, 2, 3, 4, 6, 8, 12, 16];

const save = (patch: Partial<SettingsModel>) => {
  api
    .updateSettings(patch)
    .then(markSaved)
    .catch((error: Error) => {
      useOfficeStore.getState().toast(error.message);
    });
};

function QueryCard({ office }: { office: Snapshot }) {
  const models = connectedModels(office);
  // The select shows the model that is stored, always, even when the account that gives it isn't
  // connected, because that is the one in use.
  const stored = office.settings.queryModel;
  const options = modelOptions(models, stored);
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
            value={stored}
            onChange={(event) => save({ queryModel: event.target.value })}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="help">
            Queries are answered from Mabari&apos;s own log, so they never interrupt an agent. A
            small, fast model is usually enough.
            {models.length === 0 ? ' Connect an account to choose another model.' : ''}
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
        {DEFAULT_KINDS.map((kind) => {
          const key = DEFAULTS_KEY[kind] ?? kind;
          const account = office.accounts.find((item) => item.kind === kind);
          const stored = defaults[key] ?? '';
          return [
            <label className="flabel" htmlFor={`def-${key}`} key={`${key}-label`}>
              {ACCOUNT_LABEL[kind]}
            </label>,
            <select
              className="in"
              id={`def-${key}`}
              key={key}
              style={{ maxWidth: 320 }}
              value={stored}
              onChange={(event) => save({ defaults: { ...defaults, [key]: event.target.value } })}
            >
              {modelOptions(
                account ? chooseableModels(account) : [],
                stored,
                "this account doesn't offer it",
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>,
          ];
        })}
        <label className="flabel" htmlFor="maxSessions">
          Claude Code sessions at once
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            className="in"
            id="maxSessions"
            style={{ width: 'auto' }}
            value={office.settings.maxSessions}
            onChange={(event) => save({ maxSessions: Number(event.target.value) })}
          >
            {SESSION_CHOICES.map((count) => (
              <option value={count} key={count}>
                {count}
              </option>
            ))}
          </select>
          <span className="help">
            Sessions waiting for a message give up their place when another needs it.
          </span>
        </div>
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
        <NotifyRow />
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
              checked={settings.approvalSound}
              onChange={(event) => {
                save({ approvalSound: event.target.checked });
                // Turning it on plays it, so you know what to listen for.
                if (event.target.checked) playDing();
              }}
            />
            Ding when an approval needs you
          </label>
          <button type="button" className="btn sm" onClick={playDing}>
            Play it
          </button>
        </div>
      </div>
    </div>
  );
}

/** Starts Mabari when you log in, as a service for your user only. It takes effect at the next
 * login: it never starts a second Mabari or stops this one. */
function RunAtLogin() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['loginService'], queryFn: api.loginService });
  const login = status.data;
  if (!login) return <span />;
  return (
    <div className="field">
      <label
        className="switch"
        title={login.supported ? undefined : `Not available here: ${login.detail}.`}
      >
        <input
          type="checkbox"
          id="pLogin"
          disabled={!login.supported}
          checked={login.installed}
          onChange={(event) =>
            void api
              .setLoginService(event.target.checked)
              .then((next) => {
                queryClient.setQueryData(['loginService'], next);
                markSaved();
              })
              .catch((error: Error) => useOfficeStore.getState().toast(error.message))
          }
        />
        Start Mabari when I log in
      </label>
      <span className="help">
        {login.supported
          ? 'Runs as you, on this computer only. Same as mabari service install.'
          : `Not available here: ${login.detail}.`}
      </span>
    </div>
  );
}

/** Lets other devices on the network open Mabari. Each of them signs in with the access key. */
function LanAccess({ settings }: { settings: SettingsModel }) {
  const access = useQuery({ queryKey: ['access', settings.lanAccess], queryFn: api.access });
  const control = access.data?.lanControl ?? true;
  const addresses = access.data?.addresses ?? [];
  return (
    <div className="field">
      <label
        className="switch"
        title={control ? undefined : 'In Docker, choose the published address in compose.yaml.'}
      >
        <input
          type="checkbox"
          id="pLan"
          disabled={!control}
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
          <span className="grow" id="lanAddresses">
            Other devices on your network can open{' '}
            {addresses.length
              ? addresses.map((address) => <code key={address}>{address} </code>)
              : 'Mabari'}{' '}
            and sign in with the access key. Turn this off on shared or public networks.
          </span>
        </div>
      ) : (
        <span className="help">Off. Mabari only answers on localhost.</span>
      )}
    </div>
  );
}

/** The key other devices, Docker and shared computers sign in with. */
function AccessKey() {
  const queryClient = useQueryClient();
  const access = useQuery({ queryKey: ['access'], queryFn: api.access });
  const [shown, setShown] = useState(false);
  const toast = useOfficeStore((state) => state.toast);
  const key = access.data?.key ?? '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        className="in mono"
        id="pAccessKey"
        aria-label="Access key"
        readOnly
        type={shown ? 'text' : 'password'}
        value={key}
        style={{ width: 360, maxWidth: '100%' }}
      />
      <button type="button" className="btn ghost" onClick={() => setShown(!shown)}>
        {shown ? 'Hide' : 'Show'}
      </button>
      <button
        type="button"
        className="btn ghost"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(key)
            .then(() => toast('Access key copied'))
            .catch(() => toast('Copy it by hand: the browser refused the clipboard.'))
        }
      >
        Copy
      </button>
      <button
        type="button"
        className="btn ghost"
        title="Makes a new key. Every other device has to sign in again."
        onClick={() =>
          void api
            .rotateAccess()
            .then((next) => {
              queryClient.setQueryData(['access'], next);
              void queryClient.invalidateQueries({ queryKey: ['access'] });
              toast('New access key made. Other devices sign in again with it.');
            })
            .catch((error: Error) => toast(error.message))
        }
      >
        New key
      </button>
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
        <LanAccess settings={settings} />
        <span className="flabel">Access key</span>
        <AccessKey />
        <span className="flabel">Shared computer</span>
        <label className="switch">
          <input
            type="checkbox"
            id="pRequireLogin"
            checked={settings.requireLogin}
            onChange={(event) => save({ requireLogin: event.target.checked })}
          />
          Ask for the access key on this computer too
        </label>
        <span className="flabel">Run at login</span>
        <RunAtLogin />
      </div>
    </div>
  );
}

/**
 * The second step of the wipe. It is not a dialog, but it takes focus as one would: onto Cancel,
 * the safe button, and Escape cancels it (RT-5). It exists only while it is asked, so Escape is
 * only its own then.
 */
function WipeConfirm({ cancel, wipe }: { cancel: () => void; wipe: () => void }) {
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => safe.current?.focus(), []);
  useEscape(cancel);
  return (
    <div className="banner red" role="alert">
      <Icon>
        <path d="M12 8v5M12 16h.01" />
      </Icon>
      <span className="grow">
        This cannot be undone. The projects, agents, history, accounts, keys and tokens listed above
        go now. Your settings stay.
      </span>
      <button type="button" className="btn" ref={safe} onClick={cancel}>
        Cancel
      </button>
      <button type="button" className="btn danger" onClick={wipe}>
        Yes, wipe all data
      </button>
    </div>
  );
}

function WipeCard() {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Cancelling swaps the confirmation for the Wipe button again, so focus is put back on it.
  const refocus = useRef(false);
  useEffect(() => {
    if (!confirming && refocus.current) {
      refocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);
  const cancel = () => {
    refocus.current = true;
    setConfirming(false);
  };
  const wipe = async () => {
    await api.wipe();
    setConfirming(false);
    window.location.hash = '#welcome';
    useOfficeStore.getState().toast('All data wiped');
  };
  return (
    <div className="card" style={{ borderColor: 'var(--red)' }}>
      <h2>Wipe all data</h2>
      <div className="muted" data-testid="wipeLists">
        <p>
          <b>Goes:</b> every project, agent, message, event and log entry; every account connection;
          your API keys, hub token and access key; and, if you attached Claude Code, Mabari&apos;s
          hooks in its settings, which are taken out again, with the line that makes Mabari its
          default agent if you added it.
        </p>
        <p>
          <b>Stays:</b> your settings, except that auto approve and LAN access are turned off; your
          agent files; your own folders; and everything else in Claude Code&apos;s settings,
          including a default agent you chose yourself.
        </p>
      </div>
      {confirming ? (
        <WipeConfirm cancel={cancel} wipe={() => void wipe()} />
      ) : (
        <div>
          <button
            type="button"
            className="btn danger-out"
            ref={trigger}
            onClick={() => setConfirming(true)}
          >
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
        <DemoNote office={office}>
          The accounts and the models they give are pretend while the demo runs, so the lists below
          include models from accounts you haven&apos;t connected.
        </DemoNote>
        <QueryCard office={office} />
        <DefaultsCard office={office} />
        <ApprovalsCard settings={office.settings} />
        <VoiceCard settings={office.settings} />
        <DataCard settings={office.settings} />
        <WipeCard />
      </div>
      <AutoApproveDialog office={office} />
      <SavedCue />
    </section>
  );
}
