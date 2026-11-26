import path from "node:path";
import { Clock } from "./clock.js";
import { config, llmStartsOn } from "./config.js";
import { createOpenAiClassifier, type IntentClassifier } from "./agent/llm/openai.js";
import { LlmService } from "./agent/llm/service.js";
import { loadSeedData, type SeedData } from "./data/seed.js";
import type { State } from "./domain/schemas.js";
import { HandoffService } from "./handoffs/service.js";
import { JsonStore } from "./store/jsonStore.js";
import { createRepositories, type Repositories } from "./store/repositories.js";

export interface AppContext {
  seed: SeedData;
  store: JsonStore;
  clock: Clock;
  repos: Repositories;
  handoffs: HandoffService;
  llm: LlmService;
}

/** Wires seed data, the persistent store, the clock and repositories together. */
export async function createContext(
  opts: { dataDir?: string; storeDir?: string; /** undefined = from the environment; null = none */ classifier?: IntentClassifier | null } = {},
): Promise<AppContext> {
  const seed = await loadSeedData(opts.dataDir ?? config.dataDir);
  const file = path.join(opts.storeDir ?? config.storeDir, "db.json");
  const store = await JsonStore.open(file, (): State => ({
    version: 1,
    settings: { now: config.defaultNow, llm_enabled: llmStartsOn() },
    threads: [],
    messages: [],
    handoffs: [],
  }));
  const clock = new Clock(store, config.defaultNow);
  const repos = createRepositories(store, clock);
  const classifier =
    opts.classifier !== undefined
      ? opts.classifier
      : config.openai.apiKey
        ? createOpenAiClassifier({ apiKey: config.openai.apiKey, model: config.openai.model, baseUrl: config.openai.baseUrl, timeoutMs: config.openai.timeoutMs })
        : null;
  return { seed, store, clock, repos, handoffs: new HandoffService(repos, seed, clock), llm: new LlmService(store, classifier) };
}
