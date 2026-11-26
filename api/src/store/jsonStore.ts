import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { StateSchema, type State } from "../domain/schemas.js";

/**
 * Whole-state JSON persistence.
 *
 * - State lives in memory and is mirrored to one human-readable file.
 * - Writes are serialized (one at a time) and atomic (temp file + rename), so a
 *   crash mid-write can never leave a half-written file.
 * - `update` works on a copy: if the callback throws or the result fails
 *   validation, nothing is written and memory is untouched.
 *
 * Single-process by design. Swapping to SQLite/Postgres means re-implementing
 * this class (and the repositories on top of it), not touching the agent.
 */
export class JsonStore {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    state: State,
  ) {
    this.state = state;
  }

  static async open(file: string, initial: () => State): Promise<JsonStore> {
    await mkdir(path.dirname(file), { recursive: true });
    let raw: string | null = null;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (raw === null) {
      const store = new JsonStore(file, StateSchema.parse(initial()));
      await store.persist(store.state);
      return store;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Store file ${file} is not valid JSON; refusing to overwrite it.`);
    }
    return new JsonStore(file, StateSchema.parse(parsed));
  }

  /** Current committed state. Treat as read-only; mutate only through `update`. */
  read(): Readonly<State> {
    return this.state;
  }

  /** Run `fn` against a draft copy, validate, write atomically, then commit. */
  update<T>(fn: (draft: State) => T): Promise<T> {
    const run = async () => {
      const draft = structuredClone(this.state);
      const result = fn(draft);
      const next = StateSchema.parse(draft);
      await this.persist(next);
      this.state = next;
      return result;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(state: State): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }
}
