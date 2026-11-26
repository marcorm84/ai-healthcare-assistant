import { extractDuration, extractReadings, hasClinicalCues } from "../agent/intents.js";
import { closedAllDayReason } from "../agent/hours.js";
import { parseSchedule } from "../agent/dates.js";
import { parseFaq } from "../agent/knowledge.js";
import type { SeedData } from "../data/seed.js";
import { formatTime } from "../format.js";
import { HANDOFF_DEFS } from "../handoffs/registry.js";
import { clinicDate } from "../time.js";
import type { View } from "./driver.js";

/**
 * Staff follow-up audit. Measures "avoidable staff follow-ups": extra messages staff
 * would have to send Alex because the agent (1) missed a detail, (2) created a duplicate request,
 * or (3) recorded something incorrectly. This reads a finished conversation the way a staff
 * member would and lists every such case. It is a checklist we wrote, not a person's judgment:
 * "0" means "nothing on this checklist was missed", and only for the conversations it was run on.
 */

export type FindingKind = "missed_detail" | "duplicate_request" | "incorrect_record" | "asked_known_info";

export interface Finding {
  kind: FindingKind;
  handoffId?: string;
  detail: string;
}

export interface Audit {
  handoffsAudited: number;
  findings: Finding[];
}

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

// Questions that ask Alex for something the record already holds.
const KNOWN_INFO_QUESTION = /(date of birth|phone number|which pharmacy|what pharmacy|what dose|what dosage|which medication|what medication|what is your insurance|who is your (doctor|provider)|which (doctor|provider))/i;

export function auditConversation(view: View, seed: SeedData): Audit {
  const { patient, openSlots } = seed;
  const knowledge = parseFaq(seed.faq);
  const today = clinicDate(view.now);
  const findings: Finding[] = [];
  const add = (kind: FindingKind, detail: string, handoffId?: string) => findings.push({ kind, detail, ...(handoffId ? { handoffId } : {}) });

  const byId = new Map(view.messages.map((m) => [m.id, m]));

  for (const h of view.handoffs) {
    const d = h.details;
    const sources = h.source_message_ids.map((id) => byId.get(id));
    const sourceText = sources.map((m) => m?.body ?? "").join(" \n ");

    // ---- the record must point at Alex's real words ----
    if (h.source_message_ids.length === 0) add("incorrect_record", "no source message is linked", h.id);
    sources.forEach((m, i) => {
      if (!m) add("incorrect_record", `source message ${h.source_message_ids[i]} does not exist`, h.id);
      else if (m.sender !== "patient") add("incorrect_record", `source message ${m.id} is not from Alex`, h.id);
    });

    const need = (fields: string[]) => {
      for (const f of fields) if (!filled(d[f])) add("missed_detail", `${h.type}: "${f}" is empty, staff would have to ask`, h.id);
    };

    switch (h.type) {
      case "appointment_request": {
        need(["reason", "provider", "requested_date", "time_window"]);
        // A reason that is really a date or day ("tuesday", "next friday") means the reason was misread.
        if (/\b(mon|tues?|wednes|thurs?|fri|satur|sun)(day)?\b|\b(today|tonight|tomorrow|week|weekend|morning|afternoon|evening|following|next)\b/i.test(String(d.reason))) {
          add("incorrect_record", `reason "${d.reason}" is a date or time word, not a reason`, h.id);
        }
        const date = String(d.requested_date);
        if (d.provider !== patient.last_visit.provider) add("incorrect_record", `provider "${d.provider}" is not the patient's provider`, h.id);
        if (date < today) add("incorrect_record", `requested date ${date} is in the past`, h.id);
        const closed = closedAllDayReason(knowledge.hours, date);
        if (closed) add("incorrect_record", `requested date ${date} is a day the clinic is closed (${closed})`, h.id);
        const slot = d.requested_slot as { date: string; start: string; provider: string } | null;
        if (slot) {
          if (!openSlots.some((o) => o.date === slot.date && o.start === slot.start && o.provider === slot.provider)) add("incorrect_record", `slot ${slot.date} ${slot.start} is not an open slot`, h.id);
          if (slot.date !== date) add("incorrect_record", "the slot is on a different day than the requested date", h.id);
        }
        // A time Alex gave that matches no slot must still reach staff (in the note).
        const lastText = sources.at(-1)?.body ?? "";
        const parsed = parseSchedule(lastText, { today, openSlots, suggested: [] });
        if (parsed.time && !slot && !String(d.patient_note ?? "").includes(formatTime(parsed.time))) add("missed_detail", `Alex asked for ${formatTime(parsed.time)} but staff are not told`, h.id);
        if (hasClinicalCues(sourceText) && !filled(d.patient_note) && d.reason !== "BP recheck") add("missed_detail", "Alex mentioned symptoms or readings with the request but they are not in the note", h.id);
        break;
      }
      case "refill": {
        need(["medication", "dose", "frequency", "pharmacy", "refills_remaining"]);
        const med = patient.medications.find((m) => m.name.toLowerCase() === String(d.medication).toLowerCase());
        if (!med) add("incorrect_record", `${d.medication} is not on the patient's medication list`, h.id);
        else {
          if (d.dose !== med.dose || d.frequency !== med.frequency) add("incorrect_record", "dose or frequency differs from the record", h.id);
          if (d.refills_remaining !== med.refills_remaining) add("incorrect_record", "refills_remaining differs from the record", h.id);
        }
        if (d.pharmacy !== patient.pharmacy) add("incorrect_record", "pharmacy differs from the record", h.id);
        if (/\b(out of|running|ran out|almost out|last pill|cvs|walgreens|pharmacy|mail[- ]order|90[- ]day|travel)/i.test(sourceText) && !filled(d.patient_note)) {
          add("missed_detail", "Alex said something about supply or pharmacy that staff are not told", h.id);
        }
        break;
      }
      case "clinical_question": {
        need(["question"]);
        for (const m of sources) {
          if (m && !String(d.question).includes(m.body.trim().slice(0, 80))) add("missed_detail", "the question does not contain what Alex wrote", h.id);
        }
        for (const reading of extractReadings(sourceText)) {
          const numeric = reading.replace(/^\D+/, "");
          if (!String(d.reported_readings ?? "").includes(numeric)) add("missed_detail", `reading ${numeric} was given but not recorded`, h.id);
        }
        if (extractDuration(sourceText) && !filled(d.duration)) add("missed_detail", `Alex said how long ("${extractDuration(sourceText)}") but it is not recorded`, h.id);
        if (/\b(pills?|medic\w*|meds?|dose|dosage|mg|tablets?|lisinopril)\b/i.test(sourceText) && !filled(d.related_medication)) add("missed_detail", "the question is about a medication that is not recorded", h.id);
        break;
      }
      case "billing": {
        need(["question", "balance_amount", "balance_reason"]);
        if (d.balance_amount !== patient.balance.amount || d.balance_reason !== patient.balance.reason) add("incorrect_record", "balance differs from the record", h.id);
        break;
      }
      case "other": {
        need(["reason"]);
        if (/_question$/.test(String(d.reason))) need(["question"]);
        break;
      }
      case "emergency": {
        need(["signals", "patient_messages"]);
        const said = (d.patient_messages as string[]) ?? [];
        for (const m of sources) if (m && !said.includes(m.body)) add("missed_detail", "an emergency message is not in the record", h.id);
        break;
      }
    }
  }

  // ---- duplicates: two open requests that are really the same request ----
  const open = view.handoffs.filter((h) => h.status === "pending_staff");
  const seen = new Map<string, string>();
  for (const h of open) {
    const key = HANDOFF_DEFS[h.type].dedupeKey?.(h.details);
    if (key === undefined) continue;
    const id = `${h.type}:${key}`;
    if (seen.has(id)) add("duplicate_request", `${h.id} duplicates ${seen.get(id)} (${h.type}: ${key})`, h.id);
    else seen.set(id, h.id);
  }

  // ---- asking Alex for what we already know ----
  const mentionedBp = (upTo: number) => view.messages.slice(0, upTo).some((m) => /\b(blood pressure|bp)\b/i.test(m.body));
  view.messages.forEach((m, i) => {
    if (m.sender !== "agent" || !m.body.includes("?")) return;
    if (KNOWN_INFO_QUESTION.test(m.body)) add("asked_known_info", `asked Alex for information on file: "${m.body.slice(0, 80)}"`);
    if (/what('s| is) the appointment for\?/i.test(m.body) && mentionedBp(i)) add("asked_known_info", "asked the reason for an appointment after blood pressure was already mentioned");
  });

  return { handoffsAudited: view.handoffs.length, findings };
}
