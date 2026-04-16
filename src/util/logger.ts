type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.LOG_LEVEL as Level) ?? "info";
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  // MCP uses stdio; logs must go to stderr.
  const line = JSON.stringify({ level, message, ...extra, ts: new Date().toISOString() });
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, x?: Record<string, unknown>) => log("debug", msg, x),
  info: (msg: string, x?: Record<string, unknown>) => log("info", msg, x),
  warn: (msg: string, x?: Record<string, unknown>) => log("warn", msg, x),
  error: (msg: string, x?: Record<string, unknown>) => log("error", msg, x),
};
