// SPDX-License-Identifier: Apache-2.0
import type { LiveAgent, Project } from '../gen/models.ts';

/** The colour for an agent working in no project. */
const NO_PROJECT = '#8E8E93';
const HEX = /^#[0-9a-f]{3,8}$/i;

/**
 * Where a workflow sub-agent works, for its tag: the project's name and colour, or the last part
 * of its folder when it works in no project, so a contractor never looks like it's nobody's.
 */
export function whereWorking(
  agent: Pick<LiveAgent, 'projectId' | 'folder'>,
  projects: Pick<Project, 'id' | 'name' | 'color'>[],
): { name: string; color: string } | null {
  const project = agent.projectId
    ? projects.find((item) => item.id === agent.projectId)
    : undefined;
  // Only a plain hex colour goes into the tag's style.
  if (project) {
    return { name: project.name, color: HEX.test(project.color) ? project.color : NO_PROJECT };
  }
  const folder = agent.folder
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  return folder ? { name: folder, color: NO_PROJECT } : null;
}
