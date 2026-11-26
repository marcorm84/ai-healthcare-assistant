import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Awaiting, Handoff, HandoffStatus, HandoffType, Message, Thread } from "../domain/schemas.js";
import type { JsonStore } from "./jsonStore.js";

const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export interface NewMessage {
  thread_id: string;
  sender: Message["sender"];
  body: string;
  in_reply_to?: string | null;
  outcome?: Message["outcome"];
}

export interface NewHandoff {
  patient_id: string;
  type: HandoffType;
  details: Record<string, unknown>;
  source_message_ids: string[];
}

export interface HandoffPatch {
  status?: HandoffStatus;
  /** Shallow-merged into existing details. */
  details?: Record<string, unknown>;
  /** Appended (deduplicated) to existing source_message_ids. */
  source_message_id?: string;
}

/** Typed access to persisted entities. The agent depends on this, not on JSON. */
export function createRepositories(store: JsonStore, clock: Clock) {
  const must = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`${what} not found`);
    return value;
  };

  const threads = {
    get: (id: string): Thread | undefined => store.read().threads.find((t) => t.id === id),

    list: (): readonly Thread[] => store.read().threads,

    /** One thread per patient in this demo: reuse it so history survives restarts. */
    async getOrCreate(patient_id: string, phone: string): Promise<Thread> {
      const existing = store.read().threads.find((t) => t.patient_id === patient_id && t.phone === phone);
      if (existing) return existing;
      const now = clock.now();
      const thread: Thread = {
        id: newId("thr"),
        patient_id,
        phone,
        awaiting: null,
        created_at: now,
        updated_at: now,
      };
      await store.update((s) => void s.threads.push(thread));
      return thread;
    },

    async setAwaiting(id: string, awaiting: Awaiting | null): Promise<Thread> {
      const now = clock.now();
      return store.update((s) => {
        const t = must(s.threads.find((x) => x.id === id), `Thread ${id}`);
        t.awaiting = awaiting;
        t.updated_at = now;
        return structuredClone(t);
      });
    },
  };

  const messages = {
    get: (id: string): Message | undefined => store.read().messages.find((m) => m.id === id),

    /** Chronological (insertion) order; the scenario clock can repeat timestamps. */
    listByThread: (thread_id: string): Message[] =>
      store.read().messages.filter((m) => m.thread_id === thread_id),

    async append(input: NewMessage): Promise<Message> {
      const now = clock.now();
      return store.update((s) => {
        must(s.threads.find((t) => t.id === input.thread_id), `Thread ${input.thread_id}`);
        if (input.in_reply_to) {
          const parent = s.messages.find((m) => m.id === input.in_reply_to);
          if (!parent || parent.thread_id !== input.thread_id) {
            throw new Error(`in_reply_to ${input.in_reply_to} is not in thread ${input.thread_id}`);
          }
        }
        const message: Message = {
          id: newId("msg"),
          thread_id: input.thread_id,
          sender: input.sender,
          body: input.body,
          in_reply_to: input.in_reply_to ?? null,
          created_at: now,
          ...(input.outcome ? { outcome: input.outcome } : {}),
        };
        s.messages.push(message);
        return message;
      });
    },

    /** Set how the agent handled a message (answered / handoff created / ...). */
    async setOutcome(id: string, outcome: NonNullable<Message["outcome"]>): Promise<Message> {
      return store.update((s) => {
        const m = must(s.messages.find((x) => x.id === id), `Message ${id}`);
        m.outcome = outcome;
        return structuredClone(m);
      });
    },
  };

  const handoffs = {
    get: (id: string): Handoff | undefined => store.read().handoffs.find((h) => h.id === id),

    list: (): readonly Handoff[] => store.read().handoffs,

    listByPatient: (patient_id: string): Handoff[] =>
      store.read().handoffs.filter((h) => h.patient_id === patient_id),

    async create(input: NewHandoff): Promise<Handoff> {
      const now = clock.now();
      const handoff: Handoff = {
        id: newId("ho"),
        patient_id: input.patient_id,
        type: input.type,
        status: "pending_staff",
        details: input.details,
        source_message_ids: [...new Set(input.source_message_ids)],
        created_at: now,
        updated_at: now,
      };
      await store.update((s) => void s.handoffs.push(handoff));
      return handoff;
    },

    async update(id: string, patch: HandoffPatch): Promise<Handoff> {
      const now = clock.now();
      return store.update((s) => {
        const h = must(s.handoffs.find((x) => x.id === id), `Handoff ${id}`);
        if (patch.status) h.status = patch.status;
        if (patch.details) h.details = { ...h.details, ...patch.details };
        if (patch.source_message_id && !h.source_message_ids.includes(patch.source_message_id)) {
          h.source_message_ids.push(patch.source_message_id);
        }
        h.updated_at = now;
        return structuredClone(h);
      });
    },
  };

  return { threads, messages, handoffs };
}

export type Repositories = ReturnType<typeof createRepositories>;
