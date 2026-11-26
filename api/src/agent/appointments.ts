import type { AppContext } from "../context.js";
import type { Handoff, OpenSlot } from "../domain/schemas.js";
import { formatTime, longDate } from "../format.js";
import { closedAllDayReason } from "./hours.js";
import { flags } from "./flags.js";
import { classifyIntent, hasClinicalCues } from "./intents.js";
import { parseSchedule, windowOfTime, type Schedule, type Window } from "./dates.js";
import type { ReadTools } from "./tools.js";
import type { AgentDecision, AgentInput } from "./types.js";
import { HandoffError } from "../handoffs/service.js";

/** What we remember between turns while an appointment request is being gathered. */
interface FlowContext {
  reason?: string;
  window?: Window;
  date?: string;
  suggested_slots?: OpenSlot[];
  /** What we last asked for. */
  missing?: "when" | "reason";
}

export type Mode =
  /** Reply to the clinic's outbound offer (scenario step 2 if the patient skips "yes"). */
  | "offer"
  /** Reply to "when would you like to come in?". */
  | "time"
  /** The patient asked for an appointment unprompted. */
  | "fresh"
  /** A short scheduling-looking message with nothing awaiting (e.g. "Thursday instead"). */
  | "free";

const SYMPTOM_REASON = "symptoms/concern (see note)";
/** How a reason reads in "your ___ request"; the marker reads as a plain appointment request. */
const label = (reason: string) => (reason === SYMPTOM_REASON ? "appointment" : reason);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const endSentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

type Details = {
  reason: string;
  provider: string;
  requested_date: string;
  time_window: Window;
  requested_slot: OpenSlot | null;
  patient_note: string | null;
};

/**
 * The appointment-request conversation. It only ever *requests*: it creates or
 * updates an `appointment_request` handoff and never books or reserves a slot.
 */
export function createAppointmentFlow(ctx: AppContext, tools: ReadTools) {
  const { patient, knowledge } = tools;
  const hours = knowledge.hours;
  const provider = patient.last_visit.provider;

  // ---- wording -------------------------------------------------------------

  function slotsText(slots: OpenSlot[]): string {
    const byDate = new Map<string, string[]>();
    for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) ?? []), formatTime(s.start)]);
    const today = tools.today();
    return [...byDate].map(([d, times]) => `${longDate(d, today)} at ${times.join(" or ")}`).join("; ");
  }

  function describe(d: Pick<Details, "requested_date" | "time_window" | "requested_slot">): string {
    const day = longDate(d.requested_date, tools.today());
    if (d.requested_slot) return `${day} at ${formatTime(d.requested_slot.start)}`;
    return d.time_window === "any" ? day : `${day}, in the ${d.time_window}`;
  }

  function ask(reply: string, context: FlowContext, suggested?: OpenSlot[]): AgentDecision {
    return {
      reply,
      outcome: { kind: "clarifying" },
      awaiting: {
        kind: "appointment_time",
        context: { ...context, ...(suggested ? { suggested_slots: suggested } : {}) } as Record<string, unknown>,
      },
    };
  }

  const withSlots = (lead: string, slots: OpenSlot[]) =>
    slots.length ? `${endSentence(lead)} Open times with ${provider}: ${endSentence(slotsText(slots))}` : lead;

  // ---- reason ----------------------------------------------------------------

  // A date, weekday or time of day is never a reason ("never mind about Tuesday").
  const DATEISH = /\b(mon|tues?|wednes|thurs?|fri|satur|sun)(day)?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(today|tonight|tomorrow|week|weekend|month|morning|afternoon|evening|noon|following|next|this|that)\b|\d/;

  function inferReason(text: string): string | undefined {
    const t = text.toLowerCase();
    if (/\b(blood pressure|bp|my pressure|pressure (check|recheck|looked))\b/.test(t)) return "BP recheck";
    const m = /\b(?:for|about|regarding)\s+(?:my |a |an |the )?([a-z][a-z' -]{2,50}?)(?:[.,!?]|$| on | at | this | next | tomorrow| today)/.exec(t);
    const candidate = m?.[1]?.trim();
    return candidate && !/\b(appointment|visit|time|slot)\b/.test(candidate) && (!flags.dateNeverReason || !DATEISH.test(candidate)) ? candidate : undefined;
  }

  // ---- the main entry --------------------------------------------------------

  /**
   * Handle a scheduling message. Returns null when the message isn't about
   * scheduling (so the caller can treat it as an ordinary question).
   */
  async function schedule(input: AgentInput, mode: Mode): Promise<AgentDecision | null> {
    const body = input.message.body;
    const ctxData = (mode === "offer" || mode === "time" ? (input.awaiting?.context as FlowContext) : null) ?? {};
    const today = tools.today();
    const openSlots = tools.futureOpenSlots();
    const suggested = ctxData.suggested_slots ?? openSlots;
    const target = tools.openAppointmentRequest();
    const parsed = parseSchedule(body, { today, openSlots, suggested, ...(target ? { anchor: target.details.requested_date as string } : {}) });

    let reason =
      ctxData.reason ??
      inferReason(body) ??
      (mode === "offer" ? inferReason(input.replyTo?.body ?? "") ?? (/recheck bp/i.test(patient.last_visit.plan_note) ? "BP recheck" : undefined) : undefined);

    // Symptoms already described are the reason (their words go in the note); don't ask again.
    if (!reason && hasClinicalCues(body)) reason = SYMPTOM_REASON;

    // "What's the appointment for?" -> the answer is the reason.
    // Only a plain statement counts: a question ("is it booked yet?") or any known intent is not a reason.
    // A reason may be a symptom ("knee pain"), so a clinical-sounding statement is fine; a question is not.
    const intent = classifyIntent(body);
    const looksLikeReason = (intent === "unknown" || intent === "clinical_question") && !/\?\s*$/.test(body.trim()) && body.trim().length <= 80;
    const answeringReason = mode === "time" && ctxData.missing === "reason" && !parsed.hasInfo && looksLikeReason;
    if (answeringReason) reason = body.trim().slice(0, 80);

    if (!parsed.hasInfo && !answeringReason && mode !== "fresh") return null;

    // The request we'd be changing: the open one with this reason, or the only open one if no reason was given.
    const sameTarget = target && (!reason || norm(target.details.reason as string) === norm(reason)) ? target : undefined;

    // ---- merge with what we already know, then check it ----
    const merged = {
      date: parsed.date ?? ctxData.date,
      window: parsed.window ?? ctxData.window,
    };
    const carry: FlowContext = { ...(reason ? { reason } : {}), ...(merged.window ? { window: merged.window } : {}) };

    if (parsed.vague) {
      return ask(withSlots("Which day would you like to come in?", openSlots), carry, openSlots);
    }
    if (parsed.past) {
      return ask(withSlots("That date has already passed. Which day would you like?", openSlots), carry, openSlots);
    }
    if (parsed.date) {
      const closed = closedAllDayReason(hours, parsed.date);
      if (closed) {
        return ask(
          `We're closed on ${longDate(parsed.date, today)} (${closed}). Which weekday works for you?`,
          carry,
          openSlots,
        );
      }
    }
    if (parsed.window === "evening" || (parsed.time && outsideHours(parsed.time))) {
      return ask(
        `We're open ${formatTime(hours.open)}–${formatTime(hours.close)} ${hours.zone}. What time within those hours works for you?`,
        { ...carry, ...(parsed.date ? { date: parsed.date } : {}) },
        openSlots,
      );
    }

    if (sameTarget) return applyToExisting(sameTarget, parsed, input, mode);

    if (!reason) {
      return ask(
        "What's the appointment for?",
        { ...carry, ...(merged.date ? { date: merged.date } : {}), missing: "reason" },
        openSlots,
      );
    }
    if (!merged.date) {
      const lead = merged.window ? `Got it, ${merged.window}s work. Which day would you like?` : "When would you like to come in?";
      return ask(withSlots(lead, openSlots), { ...carry, missing: "when" }, openSlots);
    }
    return create(input, reason, merged.date, merged.window ?? "any", parsed);
  }

  /** Staff-facing note: a time preference, and any symptoms/readings mentioned alongside the request. */
  function noteFor(parsed: Schedule, body: string, reason?: string): string | null {
    const parts = [
      parsed.time && !parsed.slot ? `Prefers around ${formatTime(parsed.time)}` : null,
      hasClinicalCues(body) && body.trim().slice(0, 80) !== reason ? `Patient said: "${body.trim().slice(0, 300)}"` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(". ") : null;
  }

  const outsideHours = (time: string) => time < hours.open || time >= hours.close;

  // ---- create / update -------------------------------------------------------

  async function create(input: AgentInput, reason: string, date: string, window: Window, parsed: Schedule): Promise<AgentDecision> {
    const details: Details = {
      reason,
      provider,
      requested_date: date,
      time_window: window,
      requested_slot: parsed.slot ?? null,
      patient_note: noteFor(parsed, input.message.body, reason),
    };
    try {
      const { handoff, action } = await ctx.handoffs.upsert({
        patientId: patient.patient_id,
        type: "appointment_request",
        details,
        sourceMessageId: input.message.id,
      });
      const stored = handoff.details as unknown as Details;
      const hold = stored.requested_slot ? " Choosing a time doesn't hold the slot." : "";
      const anyNote =
        stored.time_window === "any" && !stored.requested_slot
          ? " I've noted that any time of day works; tell me if you prefer morning or afternoon."
          : "";
      return {
        reply: `${endSentence(`I've submitted your ${label(stored.reason)} request with ${provider} for ${describe(stored)}`)} It's pending staff review and is not a confirmed booking.${hold}${anyNote}`,
        outcome: { kind: action === "created" ? "handoff_created" : "handoff_updated", handoff_id: handoff.id },
        awaiting: null,
      };
    } catch (err) {
      return recordingFailed(err, { reason, window, date });
    }
  }

  async function applyToExisting(existing: Handoff, parsed: Schedule, input: AgentInput, mode: Mode): Promise<AgentDecision | null> {
    const d = existing.details as unknown as Details;
    const patch: Record<string, unknown> = {};

    if (parsed.slot) {
      patch.requested_slot = parsed.slot;
      patch.requested_date = parsed.slot.date;
      patch.time_window = windowOfTime(parsed.slot.start);
    } else {
      if (parsed.date) patch.requested_date = parsed.date;
      if (parsed.window) patch.time_window = parsed.window;
      const newDate = (patch.requested_date as string | undefined) ?? d.requested_date;
      const newWindow = (patch.time_window as Window | undefined) ?? d.time_window;
      const slotStillFits =
        d.requested_slot && d.requested_slot.date === newDate && (newWindow === "any" || windowOfTime(d.requested_slot.start) === newWindow);
      if (d.requested_slot && !slotStillFits) patch.requested_slot = null; // the old slot no longer matches
      const note = noteFor(parsed, input.message.body);
      if (note) patch.patient_note = note;
    }

    if (Object.keys(patch).length === 0) {
      if (mode === "fresh") {
        return {
          reply: `${endSentence(`You already have a ${label(d.reason)} request pending for ${describe(d)}`)} If you'd like to change it, tell me the new day or time of day.`,
          outcome: { kind: "answered" },
          awaiting: null,
        };
      }
      return null;
    }

    try {
      const { handoff, action } = await ctx.handoffs.update(existing.id, patch, input.message.id);
      const now = handoff.details as unknown as Details;
      const state = "It's pending staff review and is not a confirmed booking.";
      // Same details as before (even if this is a new message): nothing to change, say so.
      if (action === "unchanged" || JSON.stringify(now) === JSON.stringify(d)) {
        return {
          reply: `${endSentence(`That's already how your ${label(now.reason)} request is set: ${describe(now)}`)} ${state}`,
          outcome: { kind: "answered" },
          awaiting: null,
        };
      }
      return {
        reply: `${endSentence(`I've updated your ${label(now.reason)} request to ${describe(now)}`)} It's still pending staff review and is not a confirmed booking.`,
        outcome: { kind: "handoff_updated", handoff_id: handoff.id },
        awaiting: null,
      };
    } catch (err) {
      return recordingFailed(err, {});
    }
  }

  /** The handoff service rejected the details (a bug, or data changed). Never claim it was saved. */
  function recordingFailed(err: unknown, carry: FlowContext): AgentDecision {
    if (!(err instanceof HandoffError)) throw err;
    console.warn("[appointments] request not recorded:", err.message);
    return ask(
      withSlots("I wasn't able to record that request. Could you tell me the day and time of day that works?", tools.futureOpenSlots()),
      { ...carry, missing: "when" },
      tools.futureOpenSlots(),
    );
  }

  // ---- other entry points ---------------------------------------------------

  /** "yes" to the clinic's offer: ask when, suggesting real open slots. */
  function askWhen(input: AgentInput): AgentDecision {
    const prior = (input.awaiting?.context as FlowContext | undefined) ?? {};
    const reason =
      prior.reason ??
      inferReason(input.replyTo?.body ?? "") ??
      (input.awaiting?.kind === "appointment_offer" && /recheck bp/i.test(patient.last_visit.plan_note) ? "BP recheck" : undefined);
    const slots = tools.futureOpenSlots();
    const lead = reason ? "Great, I can send a request to staff. When would you like to come in?" : "Happy to help. What's the appointment for, and when would you like to come in?";
    const reply = slots.length
      ? `${withSlots(lead, slots)} You can pick one of these, or tell me a day and time of day that works.`
      : lead;
    return ask(reply, { ...(reason ? { reason } : {}), missing: reason ? "when" : "reason" }, slots);
  }

  /** "Is it booked yet?": report the request's real status, never a guess. */
  function requestStatus(): AgentDecision {
    const h = tools.latestAppointmentRequest();
    if (!h) {
      return {
        reply: "I don't see an appointment request from you. Would you like me to request a time?",
        outcome: { kind: "answered" },
        awaiting: null,
      };
    }
    const d = h.details as unknown as Details;
    const what = `your ${label(d.reason)} request for ${describe(d)}`;
    const reply =
      h.status === "pending_staff"
        ? `Not yet. ${cap(what)} is pending staff review and is not booked. Texts aren't monitored continuously, so I can't say when staff will get to it.`
        : h.status === "approved"
          ? `Staff has approved ${what}. I don't see it as a booked appointment in your record yet.`
          : h.status === "completed"
            ? `Staff has marked ${what} as completed. I don't see it as a booked appointment in your record.`
            : `Staff closed ${what} without approving it.`;
    return { reply, outcome: { kind: "answered" }, awaiting: null };
  }

  return { schedule, askWhen, requestStatus };
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export type AppointmentFlow = ReturnType<typeof createAppointmentFlow>;
