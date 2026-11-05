// SPDX-License-Identifier: Apache-2.0

/**
 * The office holds the changes the server pushes back for a frame, to apply them together. An
 * answer to a call was sent after the changes the server pushed first, so it must not reach the
 * screen before they have been applied. Mabari reads "did the agent get my instruction?" the
 * moment the answer comes, and an office a frame behind says no.
 */
let apply: (() => void) | undefined;

/** Registers how to apply what is held, and returns how to take it back. */
export function holdChangesWith(applyHeld: () => void): () => void {
  apply = applyHeld;
  return () => {
    if (apply === applyHeld) apply = undefined;
  };
}

/** Applies whatever the office holds back, now. Nothing is held in most calls. */
export function applyHeldChanges(): void {
  apply?.();
}
