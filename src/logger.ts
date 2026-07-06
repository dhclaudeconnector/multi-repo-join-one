import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger };

export interface LoggerConfig {
  level?: string;
  format?: "json" | "pretty";
}

/**
 * Create the root structured logger. In dev use `pretty`, in prod use `json`
 * so logs can be shipped to an aggregator.
 */
export function createLogger(cfg: LoggerConfig = {}): Logger {
  const level = cfg.level ?? "info";
  const options: LoggerOptions = { level };

  if (cfg.format === "pretty") {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino(options);
}

/**
 * A no-op logger for tests / programmatic use where logging is unwanted.
 */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
