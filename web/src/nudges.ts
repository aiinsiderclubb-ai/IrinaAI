import { useEffect, useRef } from 'react';
import { api } from './api';

interface NudgeItem {
  key: string;
  text: string;
  createdAt: string;
}

/**
 * Polls proactive messages. Each one: browser notification when the tab is hidden, toast-like banner otherwise,
 * and an `aia:nudge` event so an open voice session can say it out loud.
 */
export function useNudges(enabled: boolean) {
  const after = useRef<string>(new Date().toISOString());
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<{ items: NudgeItem[] }>(`/api/nudges?after=${encodeURIComponent(after.current)}`);
        for (const n of r.items) {
          after.current = n.createdAt;
          window.dispatchEvent(new CustomEvent('aia:nudge', { detail: n.text }));
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Нагадування', { body: n.text });
          else window.dispatchEvent(new CustomEvent('aia:toast', { detail: `🔔 ${n.text}` }));
        }
      } catch {
        /* offline or logged out: try again later */
      }
      if (!stop) timer = window.setTimeout(poll, 30_000);
    };
    let timer = window.setTimeout(poll, 3_000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);
}
