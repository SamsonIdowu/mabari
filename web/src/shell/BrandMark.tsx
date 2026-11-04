// SPDX-License-Identifier: Apache-2.0
const FG = { fill: 'var(--fg)' };
const SURFACE = { fill: 'var(--surface)' };

export function BrandMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
      <rect width="16" height="16" rx="4" style={FG} />
      <rect x="3" y="8" width="10" height="2" style={SURFACE} />
      <rect x="5" y="4" width="6" height="4" style={SURFACE} />
      <rect x="6" y="5" width="4" height="2" style={FG} />
      <rect x="4" y="10" width="1" height="3" style={SURFACE} />
      <rect x="11" y="10" width="1" height="3" style={SURFACE} />
    </svg>
  );
}
