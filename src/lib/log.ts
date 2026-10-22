export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/** Never log message contents / tokens: only metadata (contract §9). */
export const log: Logger = {
  info: (msg, extra) => console.log(JSON.stringify({ level: 'info', msg, ...extra })),
  warn: (msg, extra) => console.warn(JSON.stringify({ level: 'warn', msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ level: 'error', msg, ...extra })),
};

export const silentLog: Logger = { info() {}, warn() {}, error() {} };

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
