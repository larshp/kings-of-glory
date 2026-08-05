export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const priorities: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Emits real event severity while treating the configured level as a minimum threshold. */
export const createStructuredLogger = (
  minimumLevel: LogLevel,
  write: (line: string) => void = console.log,
): StructuredLogger => {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (priorities[level] < priorities[minimumLevel]) return;
    // Reserved fields come last so caller-controlled metadata cannot forge severity or event names.
    write(JSON.stringify({ ...fields, level, event }));
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
};
