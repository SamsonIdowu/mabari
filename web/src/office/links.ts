// SPDX-License-Identifier: Apache-2.0
// The lines on the floor between a lead and each of its subagents, the "Connections between
// agents" layer. A subagent can sit far from its lead, at the workflow benches or across the desk
// grid, so the line is what shows who works for whom. This module only works out the lines;
// scene.ts draws them under the characters.
import type { Point } from './layout.ts';

export interface Linked {
  id: string;
  leadId: string | null;
  x: number;
  y: number;
  working: boolean;
  leaving: boolean;
}

export interface Link {
  from: Point;
  to: Point;
  /** The curve's control point, lifted above the straight line so lines read as links. */
  bend: Point;
  /** The subagent is working, so the line moves, as in the spotlight's links. */
  live: boolean;
}

/** How far above a character's feet a line meets it: about its middle. */
const BODY = 18;

/** One line from each lead to each of its subagents, for agents both on the floor and in view. */
export function teamLinks(agents: Linked[]): Link[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const links: Link[] = [];
  for (const helper of agents) {
    const lead = helper.leadId ? byId.get(helper.leadId) : undefined;
    if (!lead || lead.leaving || helper.leaving) continue;
    const from = { x: lead.x, y: lead.y - BODY };
    const to = { x: helper.x, y: helper.y - BODY };
    const lift = Math.min(60, Math.hypot(to.x - from.x, to.y - from.y) * 0.25);
    links.push({
      from,
      to,
      bend: { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift },
      live: helper.working,
    });
  }
  return links;
}
