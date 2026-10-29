const P = (d: string) => (props: { size?: number }) => (
  <svg width={props.size ?? 20} height={props.size ?? 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const IconToday = P('M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h3v3H8z');
export const IconChat = P('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z');
export const IconTasks = P('M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2');
export const IconMoney = P('M3 7h18v10H3zM7 12h.01M17 12h.01M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z');
export const IconSocial = P('M4 19V9M10 19V5M16 19v-7M22 19H2');
export const IconSettings = P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
export const IconMic = P('M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3');
export const IconSend = P('M5 12h14M13 6l6 6-6 6');
export const IconCheck = P('M5 12.5l4.5 4.5L19 7');
export const IconPlus = P('M12 5v14M5 12h14');
export const IconChevronL = P('M15 6l-6 6 6 6');
export const IconChevronR = P('M9 6l6 6-6 6');
export const IconLogo = P('M6 19l6-14 6 14M8.5 14h7');
export const IconOrb = P('M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M3 9.5c5 3 13 3 18 0');
export const IconSun = P('M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4');
export const IconMoon = P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z');
