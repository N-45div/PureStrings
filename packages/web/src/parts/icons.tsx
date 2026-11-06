/** PureStrings' marks and the screens' icons, drawn in currentColor. */

const icon = (path: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

/** A purse with its strings drawn shut. */
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--ink)" />
      <path d="M10.4 12.6c-3 2.6-4.6 6-4.1 9 .6 3.7 4.3 5.4 9.7 5.4s9.1-1.7 9.7-5.4c.5-3-1.1-6.4-4.1-9z" fill="var(--brass)" />
      <path d="M10.6 12.2l-.9-4.6 3 1.8L16 6.4l3.3 3 3-1.8-.9 4.6z" fill="var(--brass)" />
      <path d="M9.8 12.6h12.4" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 12.8c-1.6 2.6-3.8 3.4-5.4 2.6M16 12.8c1.6 2.6 3.8 3.4 5.4 2.6" stroke="var(--ink)" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export const icons = {
  purse: icon(
    <>
      <path d="M7 9c-2.6 2.3-3.8 5-3.4 7.6C4.1 19.7 7.3 21 12 21s7.9-1.3 8.4-4.4c.4-2.6-.8-5.3-3.4-7.6" />
      <path d="M7.2 9 6.5 4.8 9 6.3 12 3.5l3 2.8 2.5-1.5-.7 4.2z" />
      <path d="M6.6 9h10.8" />
    </>,
  ),
  ledger: icon(
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>,
  ),
  key: icon(
    <>
      <rect x="6" y="2.8" width="12" height="18.4" rx="3.5" />
      <rect x="8.5" y="5.5" width="7" height="5" rx="1" />
      <circle cx="12" cy="15.5" r="2.4" />
    </>,
  ),
  assistants: icon(
    <>
      <rect x="4.5" y="7" width="15" height="11.5" rx="3" />
      <path d="M12 3.5V7M9 12h.01M15 12h.01M9.5 15.3c1.4.9 3.6.9 5 0" />
    </>,
  ),
  shop: icon(
    <>
      <path d="M4 9.5 5.5 4.5h13L20 9.5" />
      <path d="M4 9.5c0 1.6 1.3 2.5 2.7 2.5S9.3 11 9.3 9.5c0 1.6 1.3 2.5 2.7 2.5s2.7-.9 2.7-2.5c0 1.6 1.3 2.5 2.6 2.5S20 11 20 9.5" />
      <path d="M5.5 12v8h13v-8M10 20v-4.5h4V20" />
    </>,
  ),
};
