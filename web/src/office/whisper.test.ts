// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { downsample, encodeWav, RATE } from './whisper.ts';

describe('downsample', () => {
  it('averages 48 kHz down to 16 kHz', () => {
    const input = Float32Array.from([0.3, 0.3, 0.3, -0.6, 0, 0.6, 1, 1, 1]);
    expect(Array.from(downsample(input, 48000))).toEqual([
      expect.closeTo(0.3),
      expect.closeTo(0),
      expect.closeTo(1),
    ]);
  });

  it('leaves 16 kHz alone and refuses lower rates', () => {
    const input = Float32Array.from([0.1, 0.2]);
    expect(downsample(input, RATE)).toBe(input);
    expect(() => downsample(input, 8000)).toThrow();
  });

  it('handles rates that are not a whole multiple', () => {
    expect(downsample(new Float32Array(44100), 44100)).toHaveLength(16000);
  });
});

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16 bit PCM file', () => {
    const bytes = encodeWav(Float32Array.from([0, 1, -1, 2]));
    const view = new DataView(bytes.buffer);
    const text = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
    expect(bytes).toHaveLength(44 + 8);
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    // Samples are clamped to the 16 bit range.
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});
