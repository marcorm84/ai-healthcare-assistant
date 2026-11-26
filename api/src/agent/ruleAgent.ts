import type { AppContext } from "../context.js";
import { formatMoney, formatTime, longDate, lowerFirst, weekdayName, weekdayOf, addDays } from "../format.js";
import type { NextOpen } from "./hours.js";
import { createAppointmentFlow } from "./appointments.js";
import { emergencyDecision } from "./safeAgent.js";
import { flags } from "./flags.js";
import { createRequestFlows } from "./requests.js";
import { classifyIntent, parseYesNo, type Intent } from "./intents.js";
import { parseFaq } from "./knowledge.js";
import { createReadTools, type ReadTools } from "./tools.js";
import type { Agent, AgentDecision, AgentInput } from "./types.js";

/** Times end in "a.m."/"p.m."; don't add a second period after them. */
const endSentence = (s: string) => (s.endsWith(".") ? s : `${s}.`);

const answered = (reply: string): AgentDecision => ({ reply, outcome: { kind: "answered" }, awaiting: null });

/** Offer to pass a question staff must answer. The reply to this offer is handled in `confirmPassToStaff`. */
function offerStaff(reply: string, reason: string, question: string): AgentDecision {
  return {
    reply: `${reply} Would you like me to pass your question to staff?`,
    outcome: { kind: "clarifying" },
    awaiting: { kind: "pass_to_staff", context: { reason, question } },
  };
}

/**
 * Deterministic, template-based agent: works with no API key and no network.
 * Facts come only from the read tools; wording comes only from the templates
 * below, so it cannot improvise advice, policy or deadlines.
 */
export function createRuleAgent(ctx: AppContext): Agent {
  const tools = createReadTools(ctx, parseFaq(ctx.seed.faq)); // fails fast on an unusable FAQ
  const appointments = createAppointmentFlow(ctx, tools);
  const requests = createRequestFlows(ctx, tools);

  const handlers: Record<Intent, (t: ReadTools, input: AgentInput) => AgentDecision> = {
    hours: (t, input) => answerHours(t, input.message.body),
    address: (t) => faqAnswer(t, "address", "Our address: "),
    phone: (t) => faqAnswer(t, "phone", "You can reach us at "),
    texting: (t) => faqAnswer(t, "texting", ""),
    what_to_bring: (t) => faqAnswer(t, "what to bring", "Please bring: "),
    cancellation_policy: (t) => faqAnswer(t, "cancellations", "For cancellations, "),
    balance: (t) => answerBalance(t),
    next_appointment: (t) => answerNextAppointment(t),
    insurance_on_file: (t) =>
      answered(`The insurance on file for you is ${t.patient.insurance.payer} (${t.patient.insurance.plan}).`),
    insurance_acceptance: (_t, input) =>
      offerStaff("I don't have information on which insurance plans the clinic accepts.", "insurance_question", input.message.body),
    // Handled in `respond` (they need async/state); present so every intent has a handler.
    request_status: () => appointments.requestStatus(),
    appointment_request: () => answered("How can I help with your appointment?"),
    change_booked_appointment: (_t, input) =>
      offerStaff("I can't cancel or reschedule appointments myself; only staff can.", "cancel_or_reschedule", input.message.body),
    // Filed in `respond` (async): refill, clinical_question and billing_request.
    refill_request: () => answered("How can I help with your refill?"),
    clinical_question: () => answered("I can't give medical advice."),
    billing_request: () => answered("How can I help with your bill?"),
    refill_info: (t) => {
      const meds = t.patient.medications;
      if (meds.length === 0) return answered("I don't see any medications on your record.");
      const lines = meds.map((m) => `${requests.medLine(m)}: ${m.refills_remaining === 0 ? "no refills" : `${m.refills_remaining} refill${m.refills_remaining === 1 ? "" : "s"}`} remaining`);
      return answered(`Your record shows ${lines.join("; ")}. If you'd like, ask me for a refill and I'll send a request to staff.`);
    },
    medications_on_file: (t) => {
      const meds = t.patient.medications;
      return answered(meds.length ? `Your record lists ${meds.map(requests.medLine).join("; ")}.` : "I don't see any medications on your record.");
    },
    pharmacy_on_file: (t) => answered(`Your pharmacy on file is ${t.patient.pharmacy}.`),
    greeting: (t) =>
      answered(`Hi ${t.patient.preferred_name}! How can I help you today? I can answer questions about the clinic, your appointments, medications and balance, or send a request to staff.`),
    help: () =>
      answered(
        "I can answer questions about the clinic (hours, address, paying a balance, what to bring), tell you about your appointments, medications and balance, and send requests to staff for appointments, refills and questions. I can't give medical advice.",
      ),
    thanks: (t) => answered(`You're welcome, ${t.patient.preferred_name}!`),
    unknown: (_t, input) =>
      offerStaff("I don't have information on that.", "other_question", input.message.body),
  };

  return {
    async respond(input) {
      // Answer to a question we asked earlier takes priority over fresh intent detection.
      if (input.awaiting?.kind === "pass_to_staff") {
        const answer = parseYesNo(input.message.body);
        if (answer) return confirmPassToStaff(ctx, input, answer);
      }

      // Reply to the clinic's outbound offer (scenario steps 1-2).
      if (input.awaiting?.kind === "appointment_offer") {
        const answer = parseYesNo(input.message.body);
        if (answer === "yes") return appointments.askWhen(input);
        if (answer === "no") return answered("No problem. If you'd like a time later, just reply here.");
        const r = isInfoQuestion(input.message.body) ? null : await appointments.schedule(input, "offer"); // e.g. "Tuesday afternoon works" without a "yes"
        if (r) return r;
      }
      // Reply to "when would you like to come in?".
      if (input.awaiting?.kind === "appointment_time") {
        const answer = parseYesNo(input.message.body);
        if (answer === "no") return answered("No problem. Let me know whenever you'd like to set up a time.");
        if (answer === "yes") return appointments.askWhen(input);
        const r = isInfoQuestion(input.message.body) ? null : await appointments.schedule(input, "time");
        if (r) return r;
      }

      // Reply to "which medication?".
      if (input.awaiting?.kind === "refill_medication") {
        const r = await requests.refillMedication(input);
        if (r) return r;
      }

      const intent = classifyIntent(input.message.body);
      // "need more lisinopril": no refill keyword, but a medication on the record and a need for more of it.
      if (flags.medNeedRefill && intent === "unknown" && requests.mentionsRefillNeed(input.message.body)) return requests.refill(input);
      if (intent === "clinical_question") {
        // A refill ask inside a medical question is filed too, so staff don't have to text Alex back.
        return requests.clinical(input, classifyRefill(input.message.body));
      }
      if (intent === "refill_request") return requests.refill(input);
      if (intent === "billing_request") return requests.billing(input);
      if (intent === "appointment_request") return (await appointments.schedule(input, "fresh"))!;
      if (intent === "unknown" && looksLikeSchedulingReply(input.message.body)) {
        // e.g. "actually can we do Thursday instead": changes the open request if there is one.
        const r = await appointments.schedule(input, "free");
        if (r) return r;
      }

      // The rules did not understand it. If AI assist is on, ask the model to CLASSIFY it (never to write a
      // reply); everything after that is the same templates, handoff validation and safety as the rules path.
      if (intent === "unknown") {
        const guess = await ctx.llm.classify(input.message.body);
        if (guess?.possible_emergency) {
          // The model can only ADD an emergency response (safe direction), never remove one.
          return emergencyDecision(ctx.handoffs, input, ["llm_possible_emergency"], "llm");
        }
        if (guess && guess.confidence === "high" && guess.intent !== "unknown") {
          return viaLlm(await routeIntent(guess.intent, input));
        }
      }
      return handlers[intent](tools, input);
    },
  };

  /** Run an intent through the same flows the rules use. */
  async function routeIntent(i: Intent, input: AgentInput): Promise<AgentDecision> {
    if (i === "clinical_question") return requests.clinical(input, classifyRefill(input.message.body));
    if (i === "refill_request") return requests.refill(input);
    if (i === "billing_request") return requests.billing(input);
    if (i === "appointment_request") return (await appointments.schedule(input, "fresh"))!;
    return handlers[i](tools, input);
  }
}

/** Mark a decision as made with AI assist (shown in the UI). */
function viaLlm(d: AgentDecision): AgentDecision {
  return d.outcome ? { ...d, outcome: { ...d.outcome, via: "llm" } } : d;
}

// ---- Answers from the FAQ ------------------------------------------------------

function faqAnswer(t: ReadTools, label: string, prefix: string): AgentDecision {
  const text = t.knowledge.get(label);
  if (!text) {
    return offerStaff("I don't have information on that.", "other_question", label);
  }
  // Keep the FAQ's own wording; adjust only the first letter so the sentence reads correctly.
  const body = prefix === "" ? text[0]!.toUpperCase() + text.slice(1) : prefix.endsWith(", ") ? lowerFirst(text) : text;
  return answered(`${prefix}${body}`);
}

function answerHours(t: ReadTools, message: string): AgentDecision {
  const { hours } = t.knowledge;
  const zone = hours.zone;
  const nextOpen = (n: NextOpen, today: string) => {
    const when = n.date === addDays(today, 1) ? `tomorrow, ${weekdayName(weekdayOf(n.date))},` : `on ${longDate(n.date, today)}`;
    return `We reopen ${when} at ${formatTime(n.open)} ${zone}.`;
  };
  const asksGeneral = !/\b(today|tonight|now)\b/i.test(message);
  if (asksGeneral) return faqAnswer(t, "hours", "Our hours: ");

  const s = t.openStatus();
  const day = weekdayName(weekdayOf(s.date));
  switch (s.kind) {
    case "open":
      return answered(`We close at ${formatTime(s.closes)} ${zone} today (${day}).`);
    case "before_open":
      return answered(`We open at ${formatTime(s.opens)} ${zone} today (${day}) and close at ${formatTime(s.closes)}.`);
    case "after_close":
      return answered(`We've closed for the day (we close at ${formatTime(s.closed_at)} ${zone}). ${nextOpen(s.next, s.date)}`);
    case "closed_day":
      return answered(`We're closed today (${s.reason}). ${nextOpen(s.next, s.date)}`);
  }
}

// ---- Answers from the patient record -------------------------------------------

function answerBalance(t: ReadTools): AgentDecision {
  const b = t.balance();
  const pay = t.knowledge.payUrl;
  const phone = t.knowledge.get("phone");
  if (b.amount <= 0) return answered("You don't have a balance on file.");
  const how = pay
    ? ` You can pay online at ${pay}, or by phone${phone ? ` at ${phone.replace(/,?\s*during business hours\.?$/i, "")}` : ""} during business hours.`
    : "";
  return answered(`Your balance is ${formatMoney(b.amount)}. According to your record, it's the ${lowerFirst(b.reason)}.${how}`);
}

/** Booked appointments and pending requests are different things; the answer keeps them apart. */
function answerNextAppointment(t: ReadTools): AgentDecision {
  const appt = t.nextBookedAppointment();
  const today = t.today();
  const request = t.openAppointmentRequest();

  const booked = appt
    ? `Your next booked appointment is the ${lowerFirst(appt.type)} with ${appt.provider} on ${longDate(appt.date, today)} at ${formatTime(appt.time)}`
    : "You don't have any booked appointments.";

  if (!request) return answered(endSentence(booked));
  const d = request.details as {
    reason: string;
    requested_date: string;
    time_window: string;
    requested_slot: { start: string } | null;
  };
  const detail = d.requested_slot ? `around ${formatTime(d.requested_slot.start)}` : d.time_window === "any" ? "any time of day" : d.time_window;
  const when = `${longDate(d.requested_date, today)} (${detail})`;
  return answered(
    `${endSentence(booked)} Separately, your ${d.reason === "symptoms/concern (see note)" ? "appointment" : d.reason} request for ${when} is still pending staff review. It isn't a booked appointment.`,
  );
}

// ---- Passing a question to staff -------------------------------------------------

async function confirmPassToStaff(ctx: AppContext, input: AgentInput, answer: "yes" | "no"): Promise<AgentDecision> {
  if (answer === "no") {
    return answered("Okay, I won't pass it along. Is there anything else I can help with?");
  }
  const { reason, question } = input.awaiting!.context as { reason: string; question: string };
  const { handoff } = await ctx.handoffs.upsert({
    patientId: input.thread.patient_id,
    type: "other",
    details: { reason, question },
    sourceMessageId: input.message.id,
  });
  return {
    reply:
      "I've passed your question to staff. It's pending staff review. Texts aren't monitored continuously, so I can't say when they'll respond.",
    outcome: { kind: "handoff_created", handoff_id: handoff.id },
    awaiting: null,
  };
}

/** A short message, or one with a change cue, that is probably about a day/time ("Thursday afternoon", "can we do Nov 12"). */
function looksLikeSchedulingReply(text: string): boolean {
  const words = text.trim().split(/\s+/).length;
  return words <= 4 || /\b(instead|actually|rather|change|update|modify|edit|switch|move|push|shift|how about|what about|can we|could we|let's|lets|works?|better|prefer|make it)\b/i.test(text);
}

/**
 * "what time do you close today?" mentions a day but is a question, not a scheduling
 * answer. A question about hours, billing, etc. must never create or change a request.
 */
function isInfoQuestion(text: string): boolean {
  const intent = classifyIntent(text);
  if (intent === "unknown" || intent === "appointment_request" || intent === "request_status") return false;
  return /\?\s*$/.test(text.trim()) || /^\s*(what|when|where|why|how|which|do|does|are|is)\b/i.test(text);
}

const REFILL_WORDS = /\b(refills?|re-?fill(s|ed)?|renew\w*)\b/i;
const classifyRefill = (text: string) => REFILL_WORDS.test(text);
