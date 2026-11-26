import { SettingsSchema } from "./domain/schemas.js";
import type { JsonStore } from "./store/jsonStore.js";

/**
 * The scenario clock. "Now" is a persisted setting, never the machine clock,
 * so it can be changed live during a demo and survives restarts.
 */
export class Clock {
  constructor(
    private readonly store: JsonStore,
    private readonly defaultNow: string,
  ) {}

  /** Current scenario time as an ISO-8601 string (with offset). */
  now(): string {
    return this.store.read().settings.now;
  }

  async set(iso: string): Promise<string> {
    const { now } = SettingsSchema.parse({ now: iso });
    await this.store.update((s) => {
      s.settings.now = now;
    });
    return now;
  }

  reset(): Promise<string> {
    return this.set(this.defaultNow);
  }
}
