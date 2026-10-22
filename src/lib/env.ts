import { existsSync } from 'node:fs';

/** Local development: read `.env` if present. On Render the variables come from the dashboard. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
