// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, emptyLogText, filterLog, logAgents, logTypes } from '../format.ts';
import { ExportMenu } from './ExportMenu.tsx';
import { PageHead } from './parts.tsx';

const TYPE_CHIPS: Record<string, string> = {
  Instruction: 'accent',
  Query: 'query',
  Approval: 'red',
};

export function Activity() {
  const office = useOfficeStore((state) => state.office);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [agent, setAgent] = useState('all');
  if (!office) return null;
  const agents = logAgents(office.log);
  // An agent that has left the log can't stay picked.
  const shownAgent = agents.includes(agent) ? agent : 'all';
  const rows = filterLog(office.log, search, type, shownAgent);

  return (
    <section data-screen="activity">
      <div className="page">
        <PageHead
          title="Activity log"
          description="Every instruction you sent, every question you asked and every approval you gave."
        />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label className="sr" htmlFor="logSearch">
            Search the log
          </label>
          <input
            className="in"
            id="logSearch"
            placeholder="Search by agent, message or outcome"
            style={{ flex: '1 1 280px' }}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="sr" htmlFor="logType">
            Type
          </label>
          <select
            className="in"
            id="logType"
            style={{ width: 'auto' }}
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="all">All types</option>
            {logTypes(office.log).map(([id, label]) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
          <label className="sr" htmlFor="logAgent">
            Agent
          </label>
          <select
            className="in"
            id="logAgent"
            style={{ width: 'auto' }}
            value={shownAgent}
            onChange={(event) => setAgent(event.target.value)}
          >
            <option value="all">All agents</option>
            {agents.map((name) => (
              <option value={name} key={name}>
                {name}
              </option>
            ))}
          </select>
          <ExportMenu filters={{ search, type, agent: shownAgent }} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Time</th>
                <th style={{ width: 150 }}>Agent</th>
                <th style={{ width: 120 }}>Type</th>
                <th>Message</th>
                <th style={{ width: 190 }}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => {
                  const agent = office.agents.find((item) => item.name === row.agent);
                  return (
                    <tr key={row.id}>
                      <td className="num muted">{clockText(row.time)}</td>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {agent ? <span className={`pdot p-${agent.provider}`} /> : null}
                          <b>{row.agent}</b>
                        </span>
                      </td>
                      <td>
                        <span className={`chip ${TYPE_CHIPS[row.type] ?? ''}`}>{row.type}</span>
                      </td>
                      <td>{row.message}</td>
                      <td>
                        <span className={`chip ${row.chip}`}>
                          {row.chip ? <i /> : null}
                          {row.outcome}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 40 }} className="muted">
                    {emptyLogText(office.log.length)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="help">
          {rows.length} of {office.log.length} entries. Kept for {office.settings.retentionDays}{' '}
          days.
        </p>
      </div>
    </section>
  );
}
