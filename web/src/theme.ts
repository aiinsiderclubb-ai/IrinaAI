import { useEffect, useState } from 'react';

/** Theme choice lives per device: 'auto' follows the system, otherwise fixed. Resolved onto <html data-theme>. */
export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'aia.theme';
const media = window.matchMedia('(prefers-color-scheme: light)');
const listeners = new Set<() => void>();

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function resolvedTheme(): 'light' | 'dark' {
  const c = themeChoice();
  return c === 'auto' ? (media.matches ? 'light' : 'dark') : c;
}

function apply() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#eef3f5' : '#04090d');
  listeners.forEach((f) => f());
}

export function setTheme(c: ThemeChoice) {
  try {
    if (c === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    /* private mode: still applies for this visit */
  }
  apply();
}

export function onThemeChange(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

media.addEventListener('change', () => themeChoice() === 'auto' && apply());
apply();

export function useTheme() {
  const [, bump] = useState(0);
  useEffect(() => onThemeChange(() => bump((n) => n + 1)), []);
  return { choice: themeChoice(), resolved: resolvedTheme(), set: setTheme };
}
