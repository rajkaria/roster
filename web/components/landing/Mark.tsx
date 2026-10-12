// Roster's mark: three people on a roster, the middle one promoted.
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="4.5" cy="5.5" r="2.3" fill="currentColor" opacity="0.38" />
      <rect x="9" y="4.3" width="12" height="2.4" rx="1.2" fill="currentColor" opacity="0.38" />
      <circle cx="4.5" cy="12" r="2.3" fill="var(--accent)" />
      <rect x="9" y="10.8" width="13" height="2.4" rx="1.2" fill="var(--accent)" />
      <circle cx="4.5" cy="18.5" r="2.3" fill="currentColor" opacity="0.38" />
      <rect x="9" y="17.3" width="8" height="2.4" rx="1.2" fill="currentColor" opacity="0.38" />
    </svg>
  );
}

export function Arrow() {
  return (
    <svg className="arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
