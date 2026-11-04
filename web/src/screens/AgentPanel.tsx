// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { api } from '../data/api.ts';
import { clockText, etaLong, etaShort, minsText, STATE_CHIPS, stateLabel } from '../format.ts';
import type { LiveAgent, Message, Snapshot } from '../gen/models.ts';
import { buildTrail, trailKinds, type TrailStep } from '../office/trail.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import {
  decisionColors,
  decisionFallbackColor,
  decisionLabels,
  providers,
  type ProviderName,
} from '../shared/tokens.ts';
import { Icon } from '../shell/Icon.tsx';
import { AddSubagentDialog, AgentSettingsDialog } from './AgentDialogs.tsx';
import { MessageBubble } from './Conversations.tsx';

type Tab = 'live' | 'trail' | 'chats';
type Dialog = 'settings' | 'subagent' | null;

const colourOf = (kind: string): string =>
  (decisionColors as Record<string, string>)[kind] ?? decisionFallbackColor;
const labelOf = (kind: string): string => (decisionLabels as Record<string, string>)[kind] ?? kind;

function elapsedText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m ${rest < 10 ? '0' : ''}${rest}s`;
}

const subModelOf = (agent: LiveAgent) =>
  agent.subModel && agent.subModel !== 'inherit' ? agent.subModel : agent.model;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sect">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function SubagentRow({ agent }: { agent: LiveAgent }) {
  const set = useOfficeUi((state) => state.set);
  const eta = etaShort(agent);
  return (
    <button
      type="button"
      className={`subrow p-${agent.provider}`}
      style={{ ['--ac' as string]: agent.hue }}
      onClick={() => set({ selected: agent.id })}
    >
      <span className="idot" />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{agent.name}</b> <span className="help mono">{agent.model}</span>
      </span>
      <span className={`chip ${STATE_CHIPS[agent.state] ?? ''}`}>{stateLabel(agent.state)}</span>
      {eta ? <span className="help num">{eta}</span> : null}
    </button>
  );
}

function OfficeSection(props: {
  agent: LiveAgent;
  subagents: LiveAgent[];
  lead: LiveAgent | undefined;
  onAdd: () => void;
}) {
  const { agent, subagents, lead } = props;
  const set = useOfficeUi((state) => state.set);
  if (lead) {
    return (
      <Section title="Works in">
        <button
          type="button"
          className="subrow"
          style={{ ['--ac' as string]: lead.hue }}
          onClick={() => set({ team: lead.id, selected: lead.id, project: 'all' })}
        >
          <span className="idot" />
          <span style={{ flex: 1 }}>
            <b>{lead.name}&apos;s office</b>{' '}
            <span className="help">Model comes from {lead.name}&apos;s agent settings</span>
          </span>
          <Icon>
            <path d="M9 6l6 6-6 6" />
          </Icon>
        </button>
      </Section>
    );
  }
  return (
    <Section title={`${agent.name}'s office`}>
      {subagents.length ? (
        subagents.map((helper) => <SubagentRow key={helper.id} agent={helper} />)
      ) : (
        <p className="help">
          No subagents yet. Subagents sit at the desks next to {agent.name} and work under it.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" onClick={props.onAdd}>
          <Icon>
            <path d="M12 5v14M5 12h14" />
          </Icon>
          Add subagent
        </button>
        {subagents.length ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => set({ team: agent.id, project: 'all' })}
          >
            Open {agent.name}&apos;s office
          </button>
        ) : null}
      </div>
      <span className="help">
        Subagents use <span className="mono">{subModelOf(agent)}</span>
        {agent.subModel === 'inherit'
          ? `, the same model as ${agent.name}.`
          : `, set in ${agent.name}'s agent settings.`}
      </span>
    </Section>
  );
}

function Estimate({ agent }: { agent: LiveAgent }) {
  const percent = Math.round(agent.progress * 100);
  const { estimate, teamEstimate } = agent;
  return (
    <div className="eta">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <b>{etaLong(agent)}</b>
        <span className="num muted">{percent}%</span>
      </div>
      <div className="bar">
        <i style={{ width: `${percent}%` }} />
      </div>
      <span className="help">
        {estimate
          ? `Likely between ${Math.max(1, Math.round(estimate.lowSeconds / 60))} and ${Math.max(2, Math.round(estimate.highSeconds / 60))} min. `
          : ''}
        {agent.name} estimates this from its own progress and recent pace. It updates as the work
        changes.
      </span>
      {teamEstimate ? (
        <span className="help" style={{ color: 'var(--fg)' }}>
          <b>Whole team:</b> {agent.name} and its subagents should be done in about{' '}
          {minsText(teamEstimate.secondsLeft)}, around {clockText(teamEstimate.finishAt)}.
        </span>
      ) : null}
    </div>
  );
}

function Counters({ agent }: { agent: LiveAgent }) {
  const plan = agent.account === 'codex' || agent.account === 'claude_code';
  const label = plan ? 'Est. at API price' : agent.account === 'hub' ? 'Not tracked' : 'Cost today';
  return (
    <>
      <div className="counters">
        <div className="cnt">
          <b className="num">{(agent.tokensIn / 1000).toFixed(1)}k</b>
          <span>Tokens in</span>
        </div>
        <div className="cnt">
          <b className="num">{(agent.tokensOut / 1000).toFixed(1)}k</b>
          <span>Tokens out</span>
        </div>
        <div className="cnt">
          <b className="num">${agent.cost.toFixed(2)}</b>
          <span>{label}</span>
        </div>
      </div>
      {plan ? (
        <p className="help" style={{ marginTop: -10 }}>
          Plan accounts are not billed per token. The estimate helps you compare agents.
        </p>
      ) : null}
    </>
  );
}

const HIGHLIGHT_MS = 2400;

function AnswerCard({ agent }: { agent: LiveAgent }) {
  const answer = useOfficeUi((state) => state.answers[agent.id]);
  const set = useOfficeUi((state) => state.set);
  if (!answer) return null;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const dismiss = () => {
    const answers = { ...useOfficeUi.getState().answers };
    delete answers[agent.id];
    set({ answers });
  };
  const show = (id: string) => {
    set({ panelTab: 'live', highlight: id });
    setTimeout(() => {
      document.getElementById(`ev-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
    setTimeout(() => set({ highlight: null }), HIGHLIGHT_MS);
  };
  return (
    <div className="answer" aria-live="polite">
      <span className="chip query" style={{ alignSelf: 'flex-start' }}>
        <Icon>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </Icon>
        Answered from the log
      </span>
      <span className="q">{answer.question}</span>
      <span>
        {answer.name} is <b>{answer.state.toLowerCase()}</b> on “{answer.task}”. So far it read{' '}
        {plural(answer.reads, 'file')}, made {plural(answer.edits, 'edit')}
        {answer.runs ? ` and ran a command ${plural(answer.runs, 'time')}` : ''}.{' '}
        {answer.latestTool ? (
          <>
            Its latest step was <code>{answer.latestTool}</code> {answer.latestSummary}.{' '}
          </>
        ) : null}
        {answer.estimate}.
      </span>
      <span className="help">
        By {answer.model}. {answer.name} was not interrupted.
      </span>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="help">Based on</span>
        {answer.events.map((id) => (
          <button type="button" className="evlink" key={id} onClick={() => show(id)}>
            {id}
          </button>
        ))}
        <button
          type="button"
          className="btn ghost sm"
          style={{ marginLeft: 'auto' }}
          onClick={dismiss}
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}

function Feed({ agent }: { agent: LiveAgent }) {
  const highlight = useOfficeUi((state) => state.highlight);
  return (
    <Section title="Live tool calls">
      <div className="feed">
        {(agent.feed ?? []).map((event) => (
          <div
            className={highlight === event.id ? 'fe hl' : 'fe'}
            id={`ev-${event.id}`}
            key={event.id}
          >
            <span className="toolchip" style={{ ['--dc' as string]: colourOf(event.tool) }}>
              {event.tool}
            </span>
            <span className="s" title={event.summary}>
              {event.summary}
            </span>
            <time className="num">{clockText(event.time)}</time>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Decision({ step }: { step: TrailStep }) {
  const colour = colourOf(step.kind);
  return (
    <div className="tstep" data-k style={{ ['--dc' as string]: colour }}>
      <span className="tn">
        <i />
      </span>
      <span className="dec" style={{ ['--dc' as string]: colour }}>
        {labelOf(step.kind)}
      </span>
      <div className="tt" style={{ marginTop: 3 }}>
        {step.title}
      </div>
      {step.detail ? <div className="help">{step.detail}</div> : null}
      {step.branch ? (
        <div className="branch" style={{ borderLeftColor: colourOf(step.branch.kind) }}>
          <span className="dec" style={{ ['--dc' as string]: colourOf(step.branch.kind) }}>
            {step.branch.label}
          </span>
          <div className="trail" style={{ marginTop: 10 }}>
            {step.branch.steps.map((child, index) => (
              <Decision key={index} step={child} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Trail({ agent, subagents }: { agent: LiveAgent; subagents: LiveAgent[] }) {
  const steps = buildTrail(agent, subagents);
  return (
    <>
      <Section title={`How ${agent.name} got here`}>
        <p className="help">
          Each step is a goal, a tool it chose, what came back and what it chose next. Branches show
          retries and work handed to a helper.
        </p>
      </Section>
      <div className="legend">
        {trailKinds(steps).map((kind) => (
          <span className="dec" style={{ ['--dc' as string]: colourOf(kind) }} key={kind}>
            {labelOf(kind)}
          </span>
        ))}
      </div>
      <div className="trail">
        {steps.map((step, index) => (
          <Decision key={index} step={step} />
        ))}
      </div>
    </>
  );
}

function Chats({ agent, office }: { agent: LiveAgent; office: Snapshot }) {
  const involved = (message: Message) =>
    message.fromAgent === agent.id || (message.toAgents ?? []).includes(agent.id);
  const messages = office.messages.filter(involved).slice(-14);
  const peers = new Map<string, number>();
  for (const message of messages) {
    const peer = message.fromAgent === agent.id ? message.toAgents?.[0] : message.fromAgent;
    if (peer) peers.set(peer, (peers.get(peer) ?? 0) + 1);
  }
  return (
    <>
      <Section title={`${agent.name}'s conversations`}>
        <p className="help">
          Messages {agent.name} sent to other agents and got back. Your own instructions are on the
          Live tab.
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[...peers].map(([id, count]) => {
            const peer = office.agents.find((item) => item.id === id);
            if (!peer) return null;
            return (
              <a className="btn sm" href="#conversations" key={id}>
                <span className="idot" style={{ ['--ac' as string]: peer.hue }} />
                {peer.name} · {count}
              </a>
            );
          })}
        </div>
      </Section>
      {messages.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              hue={office.agents.find((item) => item.id === message.fromAgent)?.hue}
              right={message.fromAgent === agent.id}
              showPair
            />
          ))}
        </div>
      ) : (
        <p className="help">No conversations yet.</p>
      )}
    </>
  );
}

function Banners({ agent }: { agent: LiveAgent }) {
  return (
    <>
      {agent.state === 'approval' && agent.approval ? (
        <div className="banner red" style={{ padding: 12 }}>
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">
            {agent.name} {agent.approval.title}.
          </span>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => useOfficeUi.getState().set({ reviewing: agent.approval?.id ?? null })}
          >
            Review
          </button>
        </div>
      ) : null}
      {agent.state === 'error' ? (
        <div className="banner red" style={{ padding: 12 }}>
          <Icon>
            <path d="M12 8v5M12 16h.01" />
          </Icon>
          <span className="grow">{agent.error}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void api.agentAction(agent.id, 'retry')}
          >
            Retry
          </button>
        </div>
      ) : null}
      {agent.queued?.length ? (
        <div className="queued">
          <b style={{ color: 'var(--amber)' }}>
            <Icon>
              <path d="M12 7v5l3 2" />
            </Icon>{' '}
            Waiting to deliver
          </b>
          <span>
            {agent.queued.map((item) => (
              <span key={item.id} style={{ display: 'block' }}>
                “{item.text}”
              </span>
            ))}
          </span>
          <span className="help">
            Claude Code reads new instructions at its next checkpoint, when the current step ends.
            Nothing is lost if you close this panel.
          </span>
        </div>
      ) : null}
    </>
  );
}

function Foot({ agent }: { agent: LiveAgent }) {
  const [confirming, setConfirming] = useState(false);
  const set = useOfficeUi((state) => state.set);
  const stop = () => {
    setConfirming(false);
    set({ selected: null, follow: false });
    void api.agentAction(agent.id, 'stop');
  };
  return (
    <div className="pfoot">
      {confirming ? (
        <div className="banner red" style={{ padding: '10px 12px' }}>
          <span className="grow">
            Stop {agent.name}? This ends the session. Unsaved work in its folder stays.
          </span>
          <button type="button" className="btn sm" onClick={() => setConfirming(false)}>
            Keep running
          </button>
          <button type="button" className="btn sm danger" onClick={stop}>
            Stop
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn"
            title="Pause after the current tool call and wait for you"
            disabled={agent.state === 'paused'}
            onClick={() => void api.agentAction(agent.id, 'interrupt')}
          >
            <Icon>
              <path d="M9 5v14M15 5v14" />
            </Icon>
            Interrupt
          </button>
          <button
            type="button"
            className="btn danger-out"
            title="End this agent session"
            onClick={() => setConfirming(true)}
          >
            <Icon>
              <path d="M6 6h12v12H6z" />
            </Icon>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

export function AgentPanel({ office, agent }: { office: Snapshot; agent: LiveAgent }) {
  const tab = useOfficeUi((state) => state.panelTab);
  const [dialog, setDialog] = useState<Dialog>(null);
  const set = useOfficeUi((state) => state.set);
  const provider = providers[agent.provider as ProviderName] ?? providers.custom;
  const project = office.projects.find((item) => item.id === agent.projectId);
  const lead = office.agents.find((item) => item.id === agent.leadId);
  const subagents = office.agents.filter((item) => item.leadId === agent.id);
  const chipClass = STATE_CHIPS[agent.state];
  const tabs: [Tab, string][] = [
    ['live', 'Live'],
    ['trail', 'Decision trail'],
    ['chats', 'Conversations'],
  ];

  return (
    <aside className="panel" aria-label="Agent details">
      <div
        className={`phd ${provider.cssClass}`}
        style={{ ['--ac' as string]: agent.hue, boxShadow: `inset 0 4px 0 ${agent.hue}` }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <h2 style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="idot" />
              {agent.name}
            </h2>
            <div className="meta">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="pdot" />
                <b>{provider.label}</b>
              </span>
              <span className="mono">{agent.model}</span>
              <span className={`chip ${chipClass ?? ''}`}>
                {chipClass ? <i /> : null}
                {stateLabel(agent.state)}
              </span>
            </div>
          </div>
          <span style={{ display: 'flex', gap: 2 }}>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Agent settings"
              title="Agent settings"
              onClick={() => setDialog('settings')}
            >
              <Icon>
                <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4" />
              </Icon>
            </button>
            <button
              type="button"
              className="btn ghost sm"
              aria-label="Close panel"
              onClick={() => set({ selected: null, follow: false })}
            >
              <Icon>
                <path d="M6 6l12 12M18 6 6 18" />
              </Icon>
            </button>
          </span>
        </div>
        <div className="meta">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Project <span className="pdot" style={{ background: project?.color ?? '#9AA0AE' }} />
            <b>{project?.name ?? 'No project'}</b>
          </span>
          <span>
            Running for <b className="num">{elapsedText(agent.elapsed)}</b>
          </span>
          <span>
            Folder <b className="mono">{agent.folder}</b>
          </span>
          {lead ? (
            <span>
              Helper of <b>{lead.name}</b>
            </span>
          ) : null}
          {subagents.length ? (
            <span>
              Helpers <b>{subagents.map((item) => item.name).join(', ')}</b>
            </span>
          ) : null}
        </div>
        <div className="seg" role="group" aria-label="Panel view">
          {tabs.map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? 'on' : ''}
              aria-pressed={tab === id}
              onClick={() => set({ panelTab: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="pbody">
        <Banners agent={agent} />
        <AnswerCard agent={agent} />
        {tab === 'live' ? (
          <>
            <Section title="Current task">
              <p style={{ fontWeight: 700, fontSize: 15 }}>{agent.task}</p>
            </Section>
            <OfficeSection
              agent={agent}
              subagents={subagents}
              lead={lead}
              onAdd={() => setDialog('subagent')}
            />
            <Estimate agent={agent} />
            <Counters agent={agent} />
            <Feed agent={agent} />
          </>
        ) : null}
        {tab === 'trail' ? <Trail agent={agent} subagents={subagents} /> : null}
        {tab === 'chats' ? <Chats agent={agent} office={office} /> : null}
      </div>
      <Foot agent={agent} key={agent.id} />
      {dialog === 'settings' ? (
        <AgentSettingsDialog
          agent={agent}
          office={office}
          lead={lead}
          close={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'subagent' ? (
        <AddSubagentDialog
          lead={agent}
          office={office}
          count={subagents.length}
          close={() => setDialog(null)}
        />
      ) : null}
    </aside>
  );
}
