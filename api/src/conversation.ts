import { withSafety } from "./agent/safeAgent.js";
import { detectEmergency, emergencyResponse, PROCESSING_FAILED_REPLY } from "./agent/safety.js";
import type { Agent } from "./agent/types.js";
import type { AppContext } from "./context.js";
import type { Handoff, Message, Thread } from "./domain/schemas.js";

export interface ThreadView {
  patient: { name: string; preferred_name: string; phone: string };
  thread: Thread;
  messages: Message[];
  handoffs: (Handoff & { summary: string })[];
  now: string;
  /** AI assist status for the UI switch. */
  agent: { llm_available: boolean; llm_enabled: boolean; model: string | null };
}

export interface InboundResult {
  patient_message: Message;
  reply: Message;
  thread: Thread;
}

/**
 * Returned when handling failed part-way (storage or an internal error). `reply_text` is what
 * the patient must see; it is NOT stored in the thread. For an emergency it is the exact
 * emergency text, so the safety message never depends on the disk working.
 */
export interface InboundFailure {
  failed: true;
  reply_text: string;
}

/**
 * Owns the two-way thread. In this demo every inbound message is treated as
 * coming from the patient's phone on file, so there is exactly one thread.
 */
export class ConversationService {
  /** Inbound messages are handled one at a time so replies never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly agent: Agent;

  constructor(
    private readonly ctx: AppContext,
    agent: Agent,
  ) {
    // Safety is applied here, unconditionally: no agent can reach the patient without it.
    this.agent = withSafety(agent, ctx.handoffs);
  }

  private get patient() {
    return this.ctx.seed.patient;
  }

  private currentThread(): Promise<Thread> {
    return this.ctx.repos.threads.getOrCreate(this.patient.patient_id, this.patient.phone);
  }

  async getThreadView(): Promise<ThreadView> {
    const thread = await this.currentThread();
    return {
      patient: { name: this.patient.name, preferred_name: this.patient.preferred_name, phone: this.patient.phone },
      thread,
      messages: this.ctx.repos.messages.listByThread(thread.id),
      handoffs: this.ctx.repos.handoffs
        .listByPatient(this.patient.patient_id)
        .map((h) => ({ ...h, summary: this.ctx.handoffs.summarize(h) })),
      now: this.ctx.clock.now(),
      agent: this.ctx.llm.status(),
    };
  }

  /**
   * Clinic outbound message (displayed and saved locally; nothing is sent).
   * `awaitingKind` records what a reply to it means, e.g. "yes" -> appointment offer.
   */
  async sendClinicMessage(body: string, awaitingKind?: string): Promise<{ message: Message; thread: Thread }> {
    return this.serialized(async () => {
      const { repos } = this.ctx;
      const thread = await this.currentThread();
      const message = await repos.messages.append({ thread_id: thread.id, sender: "clinic", body });
      const updated = await repos.threads.setAwaiting(
        thread.id,
        awaitingKind ? { kind: awaitingKind, message_id: message.id, context: {} } : null,
      );
      return { message, thread: updated };
    });
  }

  /**
   * Inbound patient message: store it, let the agent decide, store the reply.
   * Never throws for a processing/storage failure: the patient always gets an honest
   * reply (the emergency text if it was an emergency, otherwise a notice that claims nothing).
   */
  async receivePatientMessage(body: string): Promise<InboundResult | InboundFailure> {
    try {
      return await this.handleInbound(body);
    } catch (err) {
      console.error("[conversation] could not finish handling an inbound message", err);
      return { failed: true, reply_text: detectEmergency(body).detected ? emergencyResponse("text") : PROCESSING_FAILED_REPLY };
    }
  }

  private handleInbound(body: string): Promise<InboundResult> {
    return this.serialized(async () => {
      const { repos, clock } = this.ctx;
      const thread = await this.currentThread();
      const before = thread.awaiting;

      // Match the reply to the question it answers: the awaiting message if
      // there is one, otherwise the latest message from the clinic or agent.
      const earlier = repos.messages.listByThread(thread.id);
      const replyTo =
        (before && repos.messages.get(before.message_id)) ||
        [...earlier].reverse().find((m) => m.sender !== "patient") ||
        null;

      // Persist the inbound message first so it is never lost, even if the agent fails.
      const patientMessage = await repos.messages.append({
        thread_id: thread.id,
        sender: "patient",
        body,
        in_reply_to: replyTo?.id ?? null,
      });

      const decision = await this.agent.respond({
        thread,
        message: patientMessage,
        replyTo,
        awaiting: before,
        history: repos.messages.listByThread(thread.id),
        now: clock.now(),
      });

      const reply = await repos.messages.append({
        thread_id: thread.id,
        sender: "agent",
        body: decision.reply,
        in_reply_to: patientMessage.id,
      });
      const updatedPatientMessage = decision.outcome
        ? await repos.messages.setOutcome(patientMessage.id, decision.outcome)
        : patientMessage;
      const updatedThread = await repos.threads.setAwaiting(
        thread.id,
        decision.awaiting
          ? { kind: decision.awaiting.kind, message_id: reply.id, context: decision.awaiting.context ?? {} }
          : null,
      );
      return { patient_message: updatedPatientMessage, reply, thread: updatedThread };
    });
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
