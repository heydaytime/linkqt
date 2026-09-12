export function LinkqtMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="LinkQT"
    >
      <defs>
        <linearGradient id="linkqt-mark-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
        <clipPath id="linkqt-mark-clip">
          <rect width="64" height="64" rx="14" />
        </clipPath>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#linkqt-mark-g)" />
      <g
        clipPath="url(#linkqt-mark-clip)"
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="13,10 13,48 22,48" strokeWidth="5" />
        <circle cx="41" cy="26" r="11" strokeWidth="5" />
        <line x1="49" y1="34" x2="74" y2="59" strokeWidth="4.5" />
      </g>
    </svg>
  );
}
