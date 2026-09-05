import React from 'react';

// Small, dependency-free outline icon set for the app shell. Keeping the SVGs local avoids mixing
// emoji, icon fonts, and network-loaded assets, while currentColor lets every icon inherit the
// active, muted, success, or danger state of its parent control.
const PATHS = {
  layers: <><path d="m12 2.8 8 4.4-8 4.4-8-4.4 8-4.4Z"/><path d="m4 12 8 4.4 8-4.4M4 16.8l8 4.4 8-4.4"/></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r=".8" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r=".8" fill="currentColor" stroke="none"/></>,
  cloud: <path d="M7 18.5h10.5a4 4 0 0 0 .4-8A6.2 6.2 0 0 0 6 9.2a4.7 4.7 0 0 0 1 9.3Z"/>,
  target: <><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22"/></>,
  sparkle: <><path d="m12 2 1.25 4.15L17.4 7.4l-4.15 1.25L12 12.8l-1.25-4.15L6.6 7.4l4.15-1.25L12 2Z"/><path d="m18.2 13.5.72 2.38 2.38.72-2.38.72-.72 2.38-.72-2.38-2.38-.72 2.38-.72.72-2.38ZM5.2 14.6l.5 1.65 1.65.5-1.65.5-.5 1.65-.5-1.65-1.65-.5 1.65-.5.5-1.65Z"/></>,
  ticket: <><path d="M4 6.5h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4v-4Z"/><path d="M9 6.5v12"/></>,
  wand: <><path d="m4 20 10.8-10.8M13.2 7.6l3.2 3.2"/><path d="m17 2 .55 1.8 1.8.55-1.8.55L17 6.7l-.55-1.8-1.8-.55 1.8-.55L17 2ZM6.2 3.8l.42 1.38L8 5.6 6.62 6l-.42 1.4L5.78 6 4.4 5.6l1.38-.42.42-1.38Z"/></>,
  user: <><circle cx="12" cy="8" r="3.2"/><path d="M5.3 20c.45-4 2.7-6 6.7-6s6.25 2 6.7 6"/></>,
  key: <><circle cx="8.2" cy="12" r="4.2"/><path d="M12.4 12H21M17.5 12v3M20 12v2"/></>,
  network: <><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8.1 8.4 2.5 6.9M15.9 8.4l-2.5 6.9M8.5 7h7"/></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  cart: <><path d="M3 4h2l2.2 10h10.9l2-7H6"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/></>,
  send: <path d="m4.4 11.2 15.2-6.6-6.6 15.2-1.9-6.7-6.7-1.9Z"/>,
  cookie: <><path d="M20.5 13.2A8.7 8.7 0 1 1 10.8 3.5a4.2 4.2 0 0 0 5.7 5.7 4.2 4.2 0 0 0 4 4Z"/><circle cx="8" cy="9" r=".7" fill="currentColor" stroke="none"/><circle cx="7.5" cy="15.5" r=".7" fill="currentColor" stroke="none"/><circle cx="13" cy="17" r=".7" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12" r=".7" fill="currentColor" stroke="none"/></>,
  game: <><path d="M7.5 8h9a4.5 4.5 0 0 1 4.2 6.1l-1 2.7a2.3 2.3 0 0 1-3.8.8l-1.6-1.6H9.7l-1.6 1.6a2.3 2.3 0 0 1-3.8-.8l-1-2.7A4.5 4.5 0 0 1 7.5 8Z"/><path d="M8 11v4M6 13h4M16.5 12h.01M18.5 14h.01"/></>,
  sun: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M20.2 15.2A8.8 8.8 0 0 1 8.8 3.8 8.8 8.8 0 1 0 20.2 15.2Z"/>,
  minus: <path d="M5 12h14"/>,
  maximize: <rect x="5" y="5" width="14" height="14" rx="2"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  check: <path d="m5 12.5 4.2 4.2L19 7"/>,
  play: <path d="m8 5 11 7-11 7V5Z"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  trash: <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  activity: <><path d="M4 12h3l2-6 4 12 2-6h5"/></>,
  refresh: <><path d="M20 7v5h-5"/><path d="M18.1 16.4A8 8 0 1 1 19.7 9"/></>,
  download: <><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M5 20h14"/></>,
  warning: <><path d="M10.1 4.3 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.9 4.3a2.2 2.2 0 0 0-3.8 0Z"/><path d="M12 9v4M12 17h.01"/></>,
  flask: <><path d="M9 3h6M10 3v6l-5.2 8.1A2.5 2.5 0 0 0 6.9 21h10.2a2.5 2.5 0 0 0 2.1-3.9L14 9V3"/><path d="M7.4 16h9.2"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 4.8 4.8"/></>,
  star: <path d="m12 3.4 2.3 4.7 5.2.8-3.8 3.6.9 5.2L12 15.3 7.4 17.7l.9-5.2-3.8-3.6 5.2-.8L12 3.4Z"/>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  eyeOff: <><path d="m4 4 16 16M9.7 6.3A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17.2 17.2 0 0 1-2.1 2.8M14.1 14.1a3 3 0 0 1-4.2-4.2M6.3 8.1A17 17 0 0 0 2.5 12s3.5 6 9.5 6a10.8 10.8 0 0 0 2.3-.3"/></>,
  chevronDown: <path d="m7 9.5 5 5 5-5"/>,
  calendar: <><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4M16 3v4M4 10h16M8 14h2M14 14h2M8 17h2"/></>,
};

export default function Icon({ name, size = 18, strokeWidth = 1.8, className = '', title }) {
  return (
    <svg
      className={`ui-icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {PATHS[name] || PATHS.sparkle}
    </svg>
  );
}
