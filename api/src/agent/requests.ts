import type { AppContext } from "../context.js";
import type { Handoff } from "../domain/schemas.js";
import { HandoffError } from "../handoffs/service.js";
import { extractDuration, extractReadings } from "./intents.js";
import type { ReadTools } from "./tools.js";
import type { AgentDecision, AgentInput } from "./types.js";

type Medication = ReadTools["patient"]["medications"][number];

const MONITORING = "Texts aren't monitored continuously, so I can't say when they'll respond.";

const done = (reply: string, h: Handoff, kind: "handoff_created" | "handoff_updated"): AgentDecision => ({
  reply,
  outcome: { kind, handoff_id: h.id },
  awaiting: null,
});

/**
 * Refill, clinical-question and billing requests. Each one gathers what staff need
 * from the record and the message, files it as pending_staff, and says so. None of
 * them gives advice, approves anything, or asks Alex for what the record already has.
 */
export function createRequestFlows(ctx: AppContext, tools: ReadTools) {
  const { patient } = tools;

  // ---- refill ----------------------------------------------------------------

  /** Named medication, else the only one on file. Null = can't tell which. */
  function resolveMedication(text: string): Medication | null {
    const t = text.toLowerCase();
    const named = patient.medications.find((m) => t.includes(m.name.toLowerCase()));
    if (named) return named;
    return patient.medications.length === 1 ? (patient.medications[0] ?? null) : null;
  }

  /** Patient words that staff need but the record can't tell them (running out, other pharmacy...). */
  function refillNote(text: string): string | null {
    return /\b(running|ran|am|i'm|almost|nearly) (out|low)\b|\bout of\b|\blast (pill|dose)\b|\bpharmacy\b|\bcvs\b|\bwalgreens\b|\bmail[- ]order\b|\b90[- ]day\b|\btravel\w*\b/i.test(text)
      ? `Patient said: "${text.trim().slice(0, 300)}"`
      : null;
  }

  /** "need more lisinopril": a medication from the record plus a need for more of it. */
  function mentionsRefillNeed(text: string): boolean {
    const named = patient.medications.some((m) => text.toLowerCase().includes(m.name.toLowerCase()));
    return named && /\b(more|another|out of|run(ning)? out|ran out|low on|supply|bottle|need)\b/i.test(text);
  }

  const medLine = (m: Medication) => `${m.name} ${m.dose} (${m.frequency})`;

  async function refill(input: AgentInput, opts: { brief?: boolean } = {}): Promise<AgentDecision> {
    const med = resolveMedication(input.message.body);
    if (!med) {
      const names = patient.medications.map((m) => m.name).join(", ");
      return {
        reply: `Which medication would you like to refill? I have these on file: ${names}.`,
        outcome: { kind: "clarifying" },
        awaiting: { kind: "refill_medication", context: {} },
      };
    }
    const note = refillNote(input.message.body);
    const details = {
      medication: med.name,
      dose: med.dose,
      frequency: med.frequency,
      pharmacy: patient.pharmacy,
      refills_remaining: med.refills_remaining,
      patient_note: note,
    };

    const existing = ctx.handoffs.findOpen(patient.patient_id, "refill").find((h) => String(h.details.medication).toLowerCase() === med.name.toLowerCase());
    if (existing) {
      if (!note || existing.details.patient_note === note) {
        return { reply: `You already have a refill request for ${medLine(med)} pending staff review.`, outcome: { kind: "answered" }, awaiting: null };
      }
      const { handoff } = await ctx.handoffs.update(existing.id, { patient_note: note }, input.message.id);
      return done(`I've added your note to your pending refill request for ${medLine(med)}.`, handoff, "handoff_updated");
    }

    const { handoff, action } = await ctx.handoffs.upsert({
      patientId: patient.patient_id,
      type: "refill",
      details,
      sourceMessageId: input.message.id,
    });
    const kind = action === "created" ? "handoff_created" : "handoff_updated";
    if (opts.brief) {
      return done(`I've sent a refill request for ${medLine(med)} to staff, pending staff review.`, handoff, kind);
    }
    const left = med.refills_remaining === 0 ? "no refills" : `${med.refills_remaining} refill${med.refills_remaining === 1 ? "" : "s"}`;
    return done(
      `I've sent a refill request for ${medLine(med)} to staff, for your pharmacy on file: ${patient.pharmacy}. ` +
        `Your record shows ${left} remaining. It's pending staff review, and only staff can approve refills. ${MONITORING}` +
        (note ? " I've included your note for them." : ""),
      handoff,
      kind,
    );
  }

  /** The answer to "which medication?". */
  async function refillMedication(input: AgentInput): Promise<AgentDecision | null> {
    const named = patient.medications.some((m) => input.message.body.toLowerCase().includes(m.name.toLowerCase()));
    return named ? refill(input) : null;
  }

  // ---- clinical question -----------------------------------------------------

  function clinicalDetails(text: string) {
    const readings = extractReadings(text);
    const medMentioned = /\b(pills?|medic\w*|meds?|dose|dosage|mg|tablets?)\b/i.test(text) || resolveMedicationByName(text);
    const med = medMentioned ? resolveMedication(text) : null;
    return {
      question: text.trim().slice(0, 500),
      reported_readings: readings.length ? readings.join(", ") : null,
      duration: extractDuration(text),
      related_medication: med ? medLine(med) : null,
    };
  }
  const resolveMedicationByName = (text: string) => patient.medications.some((m) => text.toLowerCase().includes(m.name.toLowerCase()));

  /**
   * Medical questions are never answered, only captured for a clinician: what Alex asked,
   * the readings and how long, and which medication it concerns.
   */
  async function clinical(input: AgentInput, alsoRefill: boolean): Promise<AgentDecision> {
    const { handoff, action } = await ctx.handoffs.upsert({
      patientId: patient.patient_id,
      type: "clinical_question",
      details: clinicalDetails(input.message.body),
      sourceMessageId: input.message.id,
    });
    const kind = action === "created" ? "handoff_created" : "handoff_updated";
    const refillPart = alsoRefill ? (await refill(input, { brief: true })).reply + " " : "";
    return done(
      `${refillPart}I can't give medical advice, but I've passed your ${alsoRefill ? "other " : ""}question to the clinic for a clinician to review. ` +
        `${MONITORING} If you think you are having a medical emergency, call 911 or go to the nearest emergency room now.`,
      handoff,
      kind,
    );
  }

  // ---- billing ---------------------------------------------------------------

  async function billing(input: AgentInput): Promise<AgentDecision> {
    const b = tools.balance();
    const { handoff, action } = await ctx.handoffs.upsert({
      patientId: patient.patient_id,
      type: "billing",
      details: { question: input.message.body.trim().slice(0, 500), balance_amount: b.amount, balance_reason: b.reason },
      sourceMessageId: input.message.id,
    });
    return done(
      `I've passed your billing question to staff. It's pending staff review. ${MONITORING}`,
      handoff,
      action === "created" ? "handoff_created" : "handoff_updated",
    );
  }

  return { refill, refillMedication, mentionsRefillNeed, clinical, billing, medLine };
}

export type RequestFlows = ReturnType<typeof createRequestFlows>;
export { HandoffError };
