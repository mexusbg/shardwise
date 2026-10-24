import type { CSSProperties, ReactElement } from 'react'

const P: Record<string, ReactElement> = {
  // App mark (internal name kept): braces around a lens. Deliberately unlike any vendor logo.
  leaf: (
    <>
      <path d="M8 4c-2 0-3 1-3 3v2.5c0 1-.6 1.8-1.6 2.5 1 .7 1.6 1.5 1.6 2.5V17c0 2 1 3 3 3" />
      <path d="M16 4c2 0 3 1 3 3v2.5c0 1 .6 1.8 1.6 2.5-1 .7-1.6 1.5-1.6 2.5V17c0 2-1 3-3 3" />
      <circle cx="11.5" cy="11.5" r="2.6" />
      <path d="M13.5 13.5l2 2" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  collection: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9.5h16M4 15h16M9.5 9.5V20" />
    </>
  ),
  view: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  play: <path d="M7 5l12 7-12 7z" fill="currentColor" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  first: <path d="M17 6l-6 6 6 6M7 6v12" />,
  last: <path d="M7 6l6 6-6 6M17 6v12" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 10v10M15 10v10" />
    </>
  ),
  tree: (
    <>
      <path d="M5 4v14a2 2 0 0 0 2 2h3M5 9h5" />
      <rect x="11" y="6" width="9" height="5" rx="1" />
      <rect x="11" y="16" width="9" height="5" rx="1" />
    </>
  ),
  json: (
    <>
      <path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1" />
      <path d="M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />,
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
  update: (
    <>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
      <path d="M13 3l5 5h-5z" />
      <path d="M14 21l.6-2.6 5.2-5.2a1.4 1.4 0 0 1 2 2l-5.2 5.2z" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  import: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V3M7 8l5-5 5 5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  plug: (
    <>
      <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 17v5" />
    </>
  ),
  unplug: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9 2v4M15 2v5M18 7v4a6 6 0 0 1-1.5 4M13.5 16.8A6 6 0 0 1 6 11V7h3" />
      <path d="M12 17v5" />
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="1.2" fill="currentColor" />
      <circle cx="15" cy="6" r="1.2" fill="currentColor" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" />
      <circle cx="9" cy="18" r="1.2" fill="currentColor" />
      <circle cx="15" cy="18" r="1.2" fill="currentColor" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M14 11v6M11 14h6M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  builder: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <rect x="6" y="11" width="15" height="4" rx="1.5" />
      <rect x="6" y="17" width="15" height="4" rx="1.5" />
      <path d="M3 9v10h3M3 13h3" />
    </>
  ),
  count: <path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" />,
  // Collation: a letter and a sort arrow.
  collation: <path d="M3 18L7.5 6 12 18M4.7 14h5.6M17.5 5v14M14.5 16l3 3 3-3" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  warn: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  stepIn: <path d="M5 12h12M13 7l5 5-5 5M20 4v16" />,
  stepOut: <path d="M19 12H7M11 7l-5 5 5 5M4 4v16" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </>
  ),
  aggregate: (
    <>
      <path d="M4 5h16l-6 7v6l-4 2v-8z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  schema: (
    <>
      <rect x="3" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="10" width="7" height="5" rx="1" />
      <rect x="14" y="17" width="7" height="4" rx="1" />
      <path d="M6.5 8v4.5H14M6.5 12.5V19H14" />
    </>
  ),
  sql: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M9 12.5c0-1 1-1.5 1.8-1.2M15 11.3v3.5h1.6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.9 2.6 2.6 3 5.2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </>
  ),
  compare: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
      <path d="M10 9h4M10 15h4" />
    </>
  ),
  mask: (
    <>
      <path d="M3 8c3-2 15-2 18 0v3c0 4-3 7-9 9-6-2-9-5-9-9z" />
      <path d="M7.5 11.5c1-.8 2.5-.8 3.5 0M13 11.5c1-.8 2.5-.8 3.5 0" />
    </>
  ),
  reschema: (
    <>
      <path d="M4 7h10M4 12h7M4 17h10" />
      <path d="M17 5l3 3-3 3M20 8h-4" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9l1.5 1.5L12 8M8 15l1.5 1.5L12 14M14 9.5h3M14 15.5h3" />
    </>
  ),
  files: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />,
  paste: (
    <>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  star: <path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z" />,
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />,
  gauge: (
    <>
      <path d="M4 18a9 9 0 1 1 16 0" />
      <path d="M12 13l4-5" />
      <circle cx="12" cy="14" r="1.4" fill="currentColor" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  bookmark: <path d="M6 3h12v18l-6-4.5L6 21z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L12 6.3" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  )
}

export type IconName = keyof typeof P

export function Icon({ name, size = 15, style, className }: { name: IconName | string; size?: number; style?: CSSProperties; className?: string }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none', ...style }}
      className={className}
      aria-hidden
    >
      {P[name] ?? null}
    </svg>
  )
}
