import { z } from "zod";
import type { HandoffType, OpenSlot, Patient } from "../domain/schemas.js";

/**
 * One definition per handoff type: what staff need in `details`, how a repeat
 * is recognised, and how to check it against the patient record.
 * Adding a request type = add it to HANDOFF_TYPES and one `define(...)` here.
 */

export interface HandoffEnv {
  patient: Patient;
  openSlots: OpenSlot[];
  /** Clinic-local date from the scenario clock (YYYY-MM-DD). */
  today: string;
}

type Details = Record<string, unknown>;

export interface HandoffTypeDef {
  /** Strict: unknown keys are rejected, required fields are enforced, defaults are filled. */
  detailsSchema: z.ZodType<Details, z.ZodTypeDef, unknown>;
  /**
   * Identifies "the same request". A new request whose key matches an open one
   * updates it instead of creating a duplicate. Omit to never dedupe.
   */
  dedupeKey?: (d: Details) => string;
  /** How a change is applied to an existing record. Default: shallow merge. */
  merge?: (existing: Details, incoming: Details) => Details;
  /** Cross-checks against the record, slots and clock. Return an error message or null. */
  check?: (d: Details, env: HandoffEnv) => string | null;
  /** One line for staff lists and the UI. */
  summarize: (d: Details) => string;
}

function define<S extends z.ZodTypeAny>(def: {
  detailsSchema: S;
  dedupeKey?: (d: z.output<S>) => string;
  merge?: (existing: z.output<S>, incoming: z.output<S>) => z.output<S>;
  check?: (d: z.output<S>, env: HandoffEnv) => string | null;
  summarize: (d: z.output<S>) => string;
}): HandoffTypeDef {
  return def as unknown as HandoffTypeDef;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const joinUnique = (a: string | null, b: string | null): string | null => {
  const parts = [...(a?.split(", ") ?? []), ...(b?.split(", ") ?? [])].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(", ") : null;
};

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    // refine also runs when the regex failed, so it must never throw on junk input.
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a real calendar date");
const Hhmm = z.string().regex(/^\d{2}:\d{2}$/, "must be HH:MM");
const text = z.string().trim().min(1);
const optText = z.string().trim().min(1).nullable().default(null);

export const HANDOFF_DEFS: Record<HandoffType, HandoffTypeDef> = {
  appointment_request: define({
    detailsSchema: z
      .object({
        reason: text,
        provider: text,
        requested_date: IsoDate,
        time_window: z.enum(["morning", "afternoon", "evening", "any"]),
        /** Only when Alex picked one of the open slots. A preference, never a reservation. */
        requested_slot: z.object({ date: IsoDate, start: Hhmm, provider: text }).strict().nullable().default(null),
        patient_note: optText,
      })
      .strict(),
    dedupeKey: (d) => norm(d.reason), // one open request per reason; later changes to it update the same record
    check: (d, env) => {
      if (d.requested_date < env.today) return `requested_date ${d.requested_date} is in the past`;
      if (d.requested_slot) {
        const s = d.requested_slot;
        if (!env.openSlots.some((o) => o.date === s.date && o.start === s.start && o.provider === s.provider)) {
          return `requested_slot ${s.date} ${s.start} is not an open slot`;
        }
        if (s.date !== d.requested_date) return "requested_slot date does not match requested_date";
      }
      return null;
    },
    summarize: (d) =>
      `${d.reason} · ${d.provider} · ${d.requested_date} ${d.time_window}${d.requested_slot ? ` @ ${d.requested_slot.start}` : ""}`,
  }),

  refill: define({
    detailsSchema: z
      .object({
        medication: text,
        dose: text,
        frequency: text,
        pharmacy: text,
        refills_remaining: z.number().int().nonnegative(),
        patient_note: optText,
      })
      .strict(),
    dedupeKey: (d) => norm(d.medication),
    check: (d, env) => {
      const med = env.patient.medications.find((m) => norm(m.name) === norm(d.medication));
      if (!med) return `${d.medication} is not on the patient's medication list`;
      if (norm(med.dose) !== norm(d.dose) || norm(med.frequency) !== norm(d.frequency)) {
        return "dose/frequency does not match the record";
      }
      return null;
    },
    summarize: (d) => `${d.medication} ${d.dose}, ${d.frequency} · ${d.pharmacy} · refills left: ${d.refills_remaining}`,
  }),

  clinical_question: define({
    detailsSchema: z
      .object({
        /** The patient's question, in their words. */
        question: text,
        reported_readings: optText,
        duration: optText,
        related_medication: optText,
      })
      .strict(),
    // One open clinical question at a time: a follow-up ("also 160/100 today") adds to it.
    dedupeKey: () => "open_clinical",
    merge: (a, b) => ({
      question: a.question.includes(b.question) ? a.question : `${a.question}\n${b.question}`,
      reported_readings: joinUnique(a.reported_readings, b.reported_readings),
      duration: b.duration ?? a.duration,
      related_medication: b.related_medication ?? a.related_medication,
    }),
    summarize: (d) => `${d.question.replace(/\n/g, " | ")}${d.reported_readings ? ` (readings: ${d.reported_readings})` : ""}`,
  }),

  billing: define({
    detailsSchema: z
      .object({
        question: text,
        balance_amount: z.number().nonnegative().nullable().default(null),
        balance_reason: optText,
      })
      .strict(),
    dedupeKey: (d) => norm(d.question),
    summarize: (d) => d.question,
  }),

  other: define({
    detailsSchema: z.object({ reason: text, question: optText, notes: optText }).strict(),
    dedupeKey: (d) => `${norm(d.reason)}:${d.question ? norm(d.question) : ""}`,
    summarize: (d) => `${d.reason}${d.question ? `: ${d.question}` : ""}`,
  }),

  emergency: define({
    detailsSchema: z
      .object({
        signals: z.array(text).min(1),
        patient_messages: z.array(z.string()).min(1),
        channel: z.enum(["text", "voice"]).default("text"),
      })
      .strict(),
    dedupeKey: () => "open_emergency", // a repeat while one is open extends it
    merge: (a, b) => ({
      signals: [...new Set([...a.signals, ...b.signals])],
      patient_messages: [...a.patient_messages, ...b.patient_messages],
      channel: a.channel,
    }),
    summarize: (d) => `Possible emergency (${d.signals.join(", ")})`,
  }),
};
