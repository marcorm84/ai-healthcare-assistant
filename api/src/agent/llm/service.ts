import type { JsonStore } from "../../store/jsonStore.js";
import type { IntentClassifier, LlmClassification } from "./openai.js";

/** Whether AI assist is available (a key is configured) and switched on (persisted, so it survives a restart). */
export class LlmService {
  constructor(
    private readonly store: JsonStore,
    private readonly classifier: IntentClassifier | null,
  ) {}

  get available(): boolean {
    return this.classifier !== null;
  }
  get model(): string | null {
    return this.classifier?.model ?? null;
  }
  /** The switch, as saved. */
  get setting(): boolean {
    return this.store.read().settings.llm_enabled;
  }
  /** Actually in use: switched on AND a key exists. */
  get enabled(): boolean {
    return this.available && this.setting;
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on && !this.available) throw new Error("no_api_key");
    await this.store.update((s) => {
      s.settings.llm_enabled = on;
    });
  }

  /** Null when off, or on any failure: callers then behave exactly as without AI assist. */
  async classify(text: string): Promise<LlmClassification | null> {
    if (!this.enabled) return null;
    try {
      return await this.classifier!.classify(text);
    } catch {
      return null;
    }
  }

  status() {
    return { llm_available: this.available, llm_enabled: this.enabled, model: this.model };
  }
}
