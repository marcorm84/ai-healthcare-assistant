import { z } from "zod";

// ---- Supplied data -------------------------------------------------------

export const MedicationSchema = z.object({
  name: z.string(),
  dose: z.string(),
  frequency: z.string(),
  refills_remaining: z.number().int().nonnegative(),
});

export const PatientSchema = z.object({
  patient_id: z.string(),
  name: z.string(),
  preferred_name: z.string(),
  date_of_birth: z.string(),
  language: z.string(),
  phone: z.string(),
  conditions: z.array(z.string()),
  medications: z.array(MedicationSchema),
  pharmacy: z.string(),
  insurance: z.object({ payer: z.string(), plan: z.string() }),
  last_visit: z.object({
    date: z.string(),
    provider: z.string(),
    reason: z.string(),
    plan_note: z.string(),
  }),
  upcoming_appointments: z.array(
    z.object({
      date: z.string(),
      time: z.string(),
      provider: z.string(),
      type: z.string(),
      status: z.string(),
    }),
  ),
  balance: z.object({ amount: z.number(), reason: z.string() }),
});
export type Patient = z.infer<typeof PatientSchema>;

export const OpenSlotSchema = z.object({
  date: z.string(),
  start: z.string(),
  provider: z.string(),
});
export const OpenSlotsSchema = z.array(OpenSlotSchema);
export type OpenSlot = z.infer<typeof OpenSlotSchema>;

// ---- Conversation + handoff state ---------------------------------------

export const HANDOFF_TYPES = [
  "appointment_request",
  "refill",
  "clinical_question",
  "billing",
  "other",
  "emergency",
] as const;
export const HandoffTypeSchema = z.enum(HANDOFF_TYPES);
export type HandoffType = z.infer<typeof HandoffTypeSchema>;

export const HANDOFF_STATUSES = ["pending_staff", "approved", "completed", "rejected"] as const;
export const HandoffStatusSchema = z.enum(HANDOFF_STATUSES);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  sender: z.enum(["clinic", "patient", "agent"]),
  body: z.string(),
  /** Message this one replies to (resolves "yes" -> message 0). */
  in_reply_to: z.string().nullable(),
  created_at: z.string(),
  /** How the agent handled an inbound message (drives the "answered vs pending" UI). */
  outcome: z
    .object({
      kind: z.enum(["answered", "handoff_created", "handoff_updated", "emergency", "clarifying"]),
      handoff_id: z.string().optional(),
      /** Set when an AI model (not the rules) classified the message. */
      via: z.literal("llm").optional(),
    })
    .optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const HandoffSchema = z.object({
  id: z.string(),
  patient_id: z.string(),
  type: HandoffTypeSchema,
  status: HandoffStatusSchema,
  details: z.record(z.unknown()),
  source_message_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

// ---- Thread, settings, persisted state ----------------------------------

/** What the agent is waiting for in the next patient message ("yes" -> what?). */
export const AwaitingSchema = z.object({
  kind: z.string(),
  /** The message that asked the question; the patient's reply is matched to it. */
  message_id: z.string(),
  context: z.record(z.unknown()).default({}),
});
export type Awaiting = z.infer<typeof AwaitingSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  patient_id: z.string(),
  /** Simulated sender metadata; always the number on file in this demo. */
  phone: z.string(),
  awaiting: AwaitingSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const SettingsSchema = z.object({
  /** Scenario "now" (ISO-8601 with offset). Never read from the system clock. */
  /** AI assist switch (only effective when an API key is configured). */
  llm_enabled: z.boolean().default(false),
  now: z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d{2}:\d{2})$/.test(s), {
    message: "must be an ISO-8601 timestamp with a UTC offset",
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  settings: SettingsSchema,
  threads: z.array(ThreadSchema),
  messages: z.array(MessageSchema),
  handoffs: z.array(HandoffSchema),
});
export type State = z.infer<typeof StateSchema>;
