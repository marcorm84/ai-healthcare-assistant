import type { Handoff } from "../domain/schemas.js";
import type { HandoffService } from "../handoffs/service.js";
import { detectEmergency, emergencyResponse, findReplyViolations, SAFE_FALLBACK_REPLY } from "./safety.js";
import type { Agent, AgentDecision, AgentInput } from "./types.js";

/**
 * Wraps any agent with the non-negotiable safety rules:
 *  1. Emergency check runs first. On a hit the exact emergency text is the whole
 *     reply, an emergency handoff is logged, and the inner agent is never called.
 *  2. Every other reply is checked before it can reach the patient; a reply that
 *     gives clinical advice, invents a deadline or claims a booking is replaced.
 */
/** The emergency response + handoff as an agent decision. Shared by the regex check and the AI second opinion. */
export async function emergencyDecision(handoffs: HandoffService, input: AgentInput, signals: string[], via?: "llm"): Promise<AgentDecision> {
  const handoff = await logEmergency(handoffs, input, signals);
  return {
    reply: emergencyResponse("text"),
    outcome: { kind: "emergency", ...(handoff ? { handoff_id: handoff.id } : {}), ...(via ? { via } : {}) },
    awaiting: null,
  };
}

export function withSafety(inner: Agent, handoffs: HandoffService): Agent {
  return {
    async respond(input: AgentInput): Promise<AgentDecision> {
      const emergency = detectEmergency(input.message.body);
      if (emergency.detected) {
        return emergencyDecision(handoffs, input, emergency.signals);
      }

      const decision = await inner.respond(input);
      const violations = findReplyViolations(decision.reply);
      if (violations.length === 0) return decision;

      console.warn(
        `[safety] blocked agent reply for ${input.message.id}:`,
        violations.map((v) => `${v.rule}("${v.match}")`).join(", "),
      );
      return { ...decision, reply: SAFE_FALLBACK_REPLY };
    },
  };
}

/**
 * Log (or extend) the emergency handoff. A repeated emergency message extends the
 * open record instead of creating noise. If logging fails the patient still gets
 * the emergency response: the safety message never depends on storage.
 */
async function logEmergency(handoffs: HandoffService, input: AgentInput, signals: string[]): Promise<Handoff | null> {
  try {
    const { handoff } = await handoffs.upsert({
      patientId: input.thread.patient_id,
      type: "emergency",
      details: { signals, patient_messages: [input.message.body], channel: "text" },
      sourceMessageId: input.message.id,
    });
    return handoff;
  } catch (err) {
    console.error("[safety] failed to log emergency handoff; emergency response still sent", err);
    return null;
  }
}
