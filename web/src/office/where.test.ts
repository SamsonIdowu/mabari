// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { whereWorking } from './where.ts';

const projects = [{ id: 'p1', name: 'Experience and Quality', color: '#7FA8FF' }];

describe('whereWorking', () => {
  it("names the agent's project, in the project's colour", () => {
    expect(
      whereWorking({ projectId: 'p1', folder: '/Users/me/Projects/experience-quality' }, projects),
    ).toEqual({ name: 'Experience and Quality', color: '#7FA8FF' });
  });

  it('names the folder when the agent works in no project, or one that has gone', () => {
    expect(
      whereWorking({ projectId: null, folder: '/Users/me/Projects/mabari/web/' }, projects),
    ).toEqual({ name: 'web', color: '#8E8E93' });
    expect(whereWorking({ projectId: 'gone', folder: 'C:\\code\\shop' }, projects)!.name).toBe(
      'shop',
    );
    expect(whereWorking({ projectId: null, folder: '' }, projects)).toBeNull();
  });

  it("never puts anything but a hex colour in a tag's style", () => {
    const odd = [{ id: 'p1', name: 'Shop', color: 'red;background:url(x)' }];
    expect(whereWorking({ projectId: 'p1', folder: '' }, odd)!.color).toBe('#8E8E93');
  });
});
