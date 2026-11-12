import type { Services } from '../services.js';
import { ProjectStore, type Project } from './store.js';

export * from './store.js';

const stores = new WeakMap<Services, ProjectStore>();

/** The project store of this service set (created on first use; follows model swaps). */
export function projectsOf(s: Services): ProjectStore {
  let p = stores.get(s);
  if (!p) {
    p = new ProjectStore(s.db, () => s.llm);
    stores.set(s, p);
  }
  return p;
}

/** The project the conversation is about, if it still exists. */
export async function activeProject(s: Services): Promise<Project | undefined> {
  const id = (await s.settings.get()).activeProjectId;
  if (!id) return undefined;
  const p = await projectsOf(s).get(id);
  return p && p.status === 'active' ? p : undefined;
}
