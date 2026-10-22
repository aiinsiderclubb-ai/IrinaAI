import { useEffect, useState } from 'react';

function readHash(): { route: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [route, query] = raw.split('?');
  return { route: route || 'today', params: new URLSearchParams(query ?? '') };
}

export function useHash() {
  const [h, setH] = useState(readHash);
  useEffect(() => {
    const on = () => setH(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

export const go = (route: string) => {
  window.location.hash = `#/${route}`;
};
