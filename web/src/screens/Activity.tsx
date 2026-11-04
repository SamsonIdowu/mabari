// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { clockText, filterLog } from '../format.ts';
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
  if (!office) return null;
  const rows = filterLog(office.log, search, type);

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
            <option value="Instruction">Instructions</option>
            <option value="Query">Queries</option>
            <option value="Approval">Approvals</option>
          </select>
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
                    Nothing matches. Try a different word or type.
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
