// SPDX-License-Identifier: Apache-2.0
import sheet from './componentSheet.html?raw';

/** The sheet is captured from the prototype's own output, so it can't drift through retyping. */
export function ComponentSheet() {
  return (
    <section data-screen="components">
      <div className="page" dangerouslySetInnerHTML={{ __html: sheet }} />
    </section>
  );
}
