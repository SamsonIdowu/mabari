// SPDX-License-Identifier: Apache-2.0
// Shared by the specs for the office's delight and its phone layout: agents that report through the
// hub, projects ready to ship, and ways of reading the floor, its tags and its pixels.
import { expect, type APIRequestContext, type Page } from '@playwright/test';

const API = `http://127.0.0.1:${process.env.MABARI_API_PORT ?? '4327'}`;

export async function hubToken(request: APIRequestContext): Promise<string> {
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  return token;
}

/** Reports one event as a custom app would. Vite proxies only /api and /ws, so the hub is called directly. */
export async function hub(request: APIRequestContext, token: string, body: object) {
  const reply = await request.post(`${API}/hub/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(reply.status(), await reply.text()).toBe(200);
}

/** A project whose agents have all finished, so it can be marked complete. */
export async function shippable(
  request: APIRequestContext,
  token: string,
  name: string,
  color = '#FF6B9A',
  agents = 3,
) {
  const project = (await (
    await request.post('/api/projects', { data: { name, color } })
  ).json()) as { id: string };
  const slug = name.toLowerCase().replace(/\W+/g, '-');
  for (let index = 0; index < agents; index++) {
    const agent = `${slug}-${index}`;
    await hub(request, token, {
      agent,
      name: `${name.split(' ')[0]} ${index + 1}`,
      state: 'editing',
      task: 'Work',
    });
    const patched = await request.patch(`/api/agents/hub-${agent}`, {
      data: { projectId: project.id },
    });
    expect(patched.ok()).toBe(true);
    await hub(request, token, { agent, state: 'done', task: 'Finished the work' });
  }
  return project;
}

export async function complete(request: APIRequestContext, id: string) {
  const reply = await request.post(`/api/projects/${id}/complete`);
  expect(reply.status(), await reply.text()).toBe(200);
}

/** A crowd of agents at work, as many as asked for, across three projects. */
export async function crowd(
  request: APIRequestContext,
  token: string,
  count: number,
  states = ['editing', 'thinking', 'running', 'reading', 'browsing', 'idle', 'done'],
) {
  for (let index = 0; index < count; index++) {
    await hub(request, token, {
      agent: `crowd-${index}`,
      name: `Agent ${index + 1}`,
      state: states[index % states.length],
      task: 'Work on the thing',
    });
  }
}

/** One box on the page. */
export interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Every name tag that is drawn on the floor: the tags of agents, of agent files resting in the
 * lounge, and Mabari's own label. Those hidden, or off the stage, are not counted.
 */
export function tagBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const stage = document.querySelector('#stage')!.getBoundingClientRect();
    const boxes: Box[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('#stage .tag, #stage .mabtag')) {
      if (!element.getClientRects().length) continue;
      const rect = element.getBoundingClientRect();
      const inside =
        rect.right > stage.left &&
        rect.left < stage.right &&
        rect.bottom > stage.top &&
        rect.top < stage.bottom;
      if (!inside) continue;
      boxes.push({
        name: element.textContent?.trim().slice(0, 24) ?? '?',
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      });
    }
    return boxes;
  });
}

/** The pairs of boxes that cover each other by more than a pixel either way. */
export function overlapping(boxes: Box[]): string[] {
  const pairs: string[] = [];
  boxes.forEach((one, index) => {
    for (const two of boxes.slice(index + 1)) {
      const across = Math.min(one.right, two.right) - Math.max(one.left, two.left);
      const down = Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top);
      if (across > 1 && down > 1) pairs.push(`${one.name} over ${two.name}`);
    }
  });
  return pairs;
}

/** How many pixels of exactly this colour the floor's canvas shows right now. */
export function pixelsOf(page: Page, rgb: [number, number, number]): Promise<number> {
  return page.evaluate((want) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#floor')!;
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at] === want[0] && data[at + 1] === want[1] && data[at + 2] === want[2]) count++;
    }
    return count;
  }, rgb);
}

/** Where on the canvas pixels of exactly this colour are, boiled down to one number to compare. */
export function patternOf(page: Page, rgb: [number, number, number]): Promise<number> {
  return page.evaluate((want) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#floor')!;
    const { width, data } = (() => {
      const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      return { width: canvas.width, data: image.data };
    })();
    let hash = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at] === want[0] && data[at + 1] === want[1] && data[at + 2] === want[2]) {
        const pixel = at / 4;
        hash = (hash * 31 + (pixel % width) * 7 + Math.floor(pixel / width)) >>> 0;
      }
    }
    return hash;
  }, rgb);
}

/** Frames a second over a window, counted in the page the way the browser draws. */
export function framesPerSecond(page: Page, ms: number): Promise<number> {
  return page.evaluate(
    (window_ms) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = (now: number) => {
          count++;
          if (now - start < window_ms) requestAnimationFrame(tick);
          else resolve((count * 1000) / (now - start));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}
