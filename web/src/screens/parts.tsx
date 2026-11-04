// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

/** The tooltip on controls whose feature isn't built yet. */
export const LATER = 'Arrives in a later stage';

export function PageHead(props: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="phead">
      <div>
        <h1>{props.title}</h1>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.children}
    </div>
  );
}
