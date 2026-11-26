import type { Awaiting, Message, Thread } from "../domain/schemas.js";

/** Everything the agent gets for one inbound patient message. */
export interface AgentInput {
  thread: Thread;
  /** The inbound patient message (already persisted, so it has an id). */
  message: Message;
  /** The earlier message this one answers (the question the clinic/agent asked). */
  replyTo: Message | null;
  /** What the thread was waiting for before this message, if anything. */
  awaiting: Awaiting | null;
  /** Full thread history in order, including `message`. */
  history: Message[];
  /** Scenario "now" (ISO-8601 with offset). */
  now: string;
}

export interface AgentDecision {
  reply: string;
  /** How the inbound message was handled; drives the answered/pending UI. */
  outcome?: NonNullable<Message["outcome"]>;
  /**
   * What the *next* patient message should be matched to, or null for nothing.
   * The agent doesn't know the reply's message id yet; the conversation service
   * attaches it.
   */
  awaiting: { kind: string; context?: Record<string, unknown> } | null;
}

/** The agent decides; it never writes the thread itself. */
export interface Agent {
  respond(input: AgentInput): Promise<AgentDecision>;
}

/**
 * Temporary stand-in until the real agent (stages 4-9). Makes no claims about
 * anything: it only acknowledges receipt.
 */
export const placeholderAgent: Agent = {
  async respond() {
    return { reply: "Message received.", awaiting: null };
  },
};
