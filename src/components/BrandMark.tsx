/** Compact desktop-and-landscape mark, kept in sync with app-icon.svg. */
export function BrandMark() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="brand-tile" x1="12" y1="7" x2="89" y2="94" gradientUnits="userSpaceOnUse">
          <stop stopColor="#315FEA" />
          <stop offset="1" stopColor="#08AEB8" />
        </linearGradient>
        <linearGradient id="brand-land" x1="32" y1="35" x2="68" y2="68" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9DE5E7" />
          <stop offset="1" stopColor="#47BFC0" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="92" height="92" rx="25" fill="url(#brand-tile)" />
      <rect x="4.5" y="4.5" width="91" height="91" rx="24.5" stroke="white" strokeOpacity=".18" />

      <rect x="20" y="19" width="60" height="49" rx="8" fill="#F7FCFF" />
      <rect x="26" y="25" width="48" height="37" rx="3.5" fill="#DDF5F5" />
      <circle cx="62" cy="35" r="5" fill="#F3B94E" />
      <path d="m29 54 11-12a3 3 0 0 1 4.4-.1l6.1 6.2 4.1-4.1a3 3 0 0 1 4.3 0L71 53v6H29v-5Z" fill="url(#brand-land)" />
      <path d="M47 68v9h6v-9M39 79h22" stroke="#F7FCFF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
