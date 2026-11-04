// SPDX-License-Identifier: Apache-2.0
import { api } from '../data/api.ts';
import type { Handlers, Listener } from './speech.ts';

/** whisper.cpp reads 16 kHz mono WAV. */
export const RATE = 16000;
/** Shorter than this is a tap on the mic, not speech, so nothing is sent to Whisper. */
const MIN_SECONDS = 0.3;

/** Averages each run of input samples down to the target rate. Speech needs nothing finer. */
export function downsample(input: Float32Array, from: number, to = RATE): Float32Array {
  if (from === to) return input;
  if (from < to) throw new Error('Recording rate is below 16 kHz');
  const ratio = from / to;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let at = start; at < end; at++) sum += input[at] ?? 0;
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

/** A 16 bit PCM mono WAV file. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes a second
  view.setUint16(32, 2, true); // bytes a frame
  view.setUint16(34, 16, true); // bits a sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return bytes;
}

function join(chunks: Float32Array[]): Float32Array {
  const all = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

// Copies each block of microphone samples to the page. Loaded from a blob, so no extra file.
const WORKLET = `registerProcessor('mabari-pcm', class extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
});`;

/**
 * Records the microphone while held, then sends the recording to Mabari's own server, where
 * whisper.cpp turns it into text on this computer. The text arrives after release, so onText
 * comes once, followed by onEnd.
 */
export function recordForWhisper(handlers: Handlers, lang = navigator.language): Listener {
  const chunks: Float32Array[] = [];
  const request = new AbortController();
  let finished = false;
  let stopping = false;
  let release: () => void = () => undefined;
  let rate = RATE;

  const end = () => {
    if (finished) return;
    finished = true;
    handlers.onEnd();
  };
  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    release();
    handlers.onError(message);
  };

  const transcribe = async () => {
    release();
    const samples = downsample(join(chunks), rate);
    if (samples.length < RATE * MIN_SECONDS) {
      end();
      return;
    }
    const wav = new Blob([encodeWav(samples).buffer as ArrayBuffer], { type: 'audio/wav' });
    try {
      const { text } = await api.transcribe(wav, lang, request.signal);
      if (finished) return;
      handlers.onText(text.trim());
      end();
    } catch (error) {
      if (request.signal.aborted) return;
      fail(error instanceof Error ? error.message : "Local Whisper couldn't turn that into text.");
    }
  };

  const open = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      fail('Mabari needs your OK to use the microphone.');
      return;
    }
    const context = new AudioContext();
    // Started from a key or pointer press, but resume anyway in case the browser held it back.
    void context.resume().catch(() => undefined);
    release = () => {
      release = () => undefined;
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    };
    if (finished) {
      release();
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      rate = context.sampleRate;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'mabari-pcm');
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!stopping) chunks.push(event.data);
      };
      source.connect(node);
      // A silent path to the speakers keeps the browser pulling audio through the recorder.
      const mute = context.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(context.destination);
    } catch {
      fail("This browser can't record for Local Whisper.");
      return;
    }
  };
  const opening = open();

  return {
    stop: () => {
      if (stopping || finished) return;
      stopping = true;
      // If the mic is still opening, transcribe once it has, with whatever was heard.
      void opening.then(() => {
        if (!finished) void transcribe();
      });
    },
    abort: () => {
      request.abort();
      stopping = true;
      release();
      end();
    },
  };
}
