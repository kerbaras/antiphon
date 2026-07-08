// Zero-dependency structured logging: one JSON line per event on stdout,
// e.g. {"level":"warn","ts":"…","msg":"…","module":"signaling","sessionId":"…"}.
// Level threshold comes from LOG_LEVEL (validated in config.ts).

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = parseLogLevel(process.env.LOG_LEVEL) ?? "info";

export function parseLogLevel(raw: string | undefined): LogLevel | null {
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : null;
}

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** New logger with extra bound context (e.g. sessionId). */
  child(fields: LogFields): Logger;
}

export function createLogger(bound: LogFields = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < ORDER[threshold]) return;
    const entry: LogFields = { level, ts: new Date().toISOString(), msg, ...bound, ...fields };
    for (const [key, value] of Object.entries(entry)) {
      if (value instanceof Error) entry[key] = value.stack ?? value.message;
    }
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...bound, ...fields }),
  };
}
