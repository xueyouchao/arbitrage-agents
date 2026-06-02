/**
 * Tiny .env loader. We avoid dotenv as a dep — the format is well-defined
 * enough to parse in 30 lines, and it keeps install footprint minimal.
 *
 * Idempotent: safe to call multiple times; later calls are no-ops.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadEnv(path = ".env"): void {
  if (loaded) return;
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    loaded = true;
    return;
  }
  const text = readFileSync(full, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
  loaded = true;
}
