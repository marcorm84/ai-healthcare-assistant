import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Parses KEY=VALUE lines (comments and blank values ignored, optional quotes stripped). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") out[m[1]!] = value;
  }
  return out;
}

/** Minimal .env loader (no dependency). Real environment variables win over the file. */
function loadDotEnv(file: string) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // no .env: fine, everything has a default
  }
  for (const [k, v] of Object.entries(parseDotEnv(text))) if (process.env[k] === undefined) process.env[k] = v;
}
loadDotEnv(path.join(root, ".env"));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** Supplied, read-only seed data (patient, FAQ, slots). */
  dataDir: process.env.DATA_DIR ?? path.join(root, "data"),
  /** Mutable runtime state (threads, handoffs, clock). Gitignored. */
  storeDir: process.env.STORE_DIR ?? path.join(root, "var"),
  /** Scenario clock: Wed Nov 4, 2026, 10:00 a.m. Pacific (PST, UTC-8). */
  defaultNow: "2026-11-04T10:00:00-08:00",
  clinicTimeZone: "America/Los_Angeles",
  /** Optional AI assist. Without a key the switch is disabled and the agent is purely rules-based. */
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 8000),
  },
};

/** Whether AI assist starts ON in a brand-new store (the UI switch overrides it afterwards). */
export const llmStartsOn = () => process.env.AGENT_LLM === "on";
