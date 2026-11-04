// SPDX-License-Identifier: Apache-2.0
const INK = '#0C0C0C';
const RIM = { stroke: 'var(--fg)' };

/** Mabari's head, for its builder card, notes and updates button. */
export function MabariHead({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16.5" r="13.6" fill="#1E1E20" style={RIM} strokeWidth="1.4" />
      <path
        d="M4.2 15.2A11.8 11.8 0 0 1 27.8 15.2"
        fill="none"
        stroke="#F4F4F4"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <ellipse cx="16" cy="18" rx="9.6" ry="7.6" fill="#FFFFFF" />
      <ellipse cx="12.4" cy="17" rx="1.7" ry="2.1" fill={INK} />
      <ellipse cx="19.6" cy="17" rx="1.7" ry="2.1" fill={INK} />
      <circle cx="11.9" cy="16.3" r=".6" fill="#fff" />
      <circle cx="19.1" cy="16.3" r=".6" fill="#fff" />
      <path
        d="M12.6 21.3Q15.8 23.6 19.2 21"
        fill="none"
        stroke={INK}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M27.6 19.6Q27 23.4 21.6 22.6"
        fill="none"
        stroke={INK}
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <circle cx="21.2" cy="22.5" r="1.1" fill={INK} />
      <ellipse
        cx="28.2"
        cy="17.2"
        rx="2.5"
        ry="3.4"
        fill="#F4F4F4"
        stroke={INK}
        strokeWidth="1.1"
      />
    </svg>
  );
}
