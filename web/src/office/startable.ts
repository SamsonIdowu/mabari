// SPDX-License-Identifier: Apache-2.0
import type { AgentDef, Project } from '../gen/models.ts';

/**
 * The agent files someone can start: turned on, not Mabari, who is always at work, and not one
 * whose project is completed.
 */
export function startable(
  defs: AgentDef[],
  projects: Pick<Project, 'id' | 'status'>[] = [],
): AgentDef[] {
  const done = new Set(
    projects.filter((project) => project.status === 'done').map((project) => project.id),
  );
  return defs
    .filter(
      (def) => def.enabled && !def.system && !(def.scope === 'project' && done.has(def.projectId)),
    )
    .sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) ||
        a.projectId.localeCompare(b.projectId) ||
        a.name.localeCompare(b.name),
    );
}
