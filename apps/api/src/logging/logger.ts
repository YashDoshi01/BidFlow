export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Defence in depth (CLAUDE.md rule 17): call sites must not pass secrets, but
// if one does, these keys are replaced before anything is written.
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|hash/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  const emit = (lvl: LogLevel, message: string, fields: LogFields = {}): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: lvl,
        msg: message,
        ...(redact(fields) as LogFields),
      }),
    );
  };
  return {
    debug: (m, f) => {
      emit('debug', m, f);
    },
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
  };
}
