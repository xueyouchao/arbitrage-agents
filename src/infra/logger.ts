/**
 * Structured JSON logger. Writes to stdout AND to a daily-rotated file under
 * cfg.logPath. Format is one JSON object per line (NDJSON), so log aggregators
 * (or the forensics agent) can tail it cheaply.
 */
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[cfg.logLevel];
let stream: NodeJS.WritableStream | null = null;
let currentDate = "";

function openStream() {
  if (!existsSync(cfg.logPath)) mkdirSync(cfg.logPath, { recursive: true });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== currentDate) {
    currentDate = today;
    stream = createWriteStream(join(cfg.logPath, `bot-${today}.ndjson`), { flags: "a" });
  }
  return stream;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  });
  process.stdout.write(line + "\n");
  const s = openStream();
  if (s) s.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
