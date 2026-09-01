/**
 * Logging fuer webpilot.
 *
 * Zwei Eigenschaften sind hier wichtig:
 *  - Bei stdio-MCP gehoert stdout dem Protokoll. Jede Logzeile geht auf stderr.
 *  - Das MCP-Tool `log_tail(n)` braucht die letzten n Zeilen, also haelt ein
 *    Ringpuffer sie im Speicher.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let buffer: LogEntry[] = [];
let capacity = 500;
let minLevel: LogLevel = (() => {
  const raw = process.env['WEBPILOT_LOG_LEVEL'];
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
})();

export function configureLog(options: { capacity?: number; level?: LogLevel }): void {
  if (typeof options.capacity === 'number' && options.capacity > 0) {
    capacity = Math.floor(options.capacity);
    if (buffer.length > capacity) buffer = buffer.slice(-capacity);
  }
  if (options.level) minLevel = options.level;
}

function push(level: LogLevel, scope: string, message: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, message };
  buffer.push(entry);
  if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  // Niemals process.stdout: dort laeuft bei `webpilot mcp` das JSON-RPC-Protokoll.
  process.stderr.write(`${entry.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string) => push('debug', scope, message),
    info: (message: string) => push('info', scope, message),
    warn: (message: string) => push('warn', scope, message),
    error: (message: string) => push('error', scope, message),
  };
}

/** Die letzten `n` Logzeilen, aelteste zuerst. */
export function logTail(n: number): LogEntry[] {
  if (n <= 0) return [];
  return buffer.slice(-n);
}

export function formatEntry(entry: LogEntry): string {
  return `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`;
}
