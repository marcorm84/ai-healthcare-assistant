/** Shapes returned by the API (see api/src/domain/schemas.ts). Kept minimal on purpose. */
export type Sender = "clinic" | "patient" | "agent";
export type OutcomeKind = "answered" | "handoff_created" | "handoff_updated" | "emergency" | "clarifying";
export type HandoffStatus = "pending_staff" | "approved" | "completed" | "rejected";
export type HandoffType = "appointment_request" | "refill" | "clinical_question" | "billing" | "other" | "emergency";

export interface Message {
  id: string;
  thread_id: string;
  sender: Sender;
  body: string;
  in_reply_to: string | null;
  created_at: string;
  outcome?: { kind: OutcomeKind; handoff_id?: string; via?: "llm" };
}

export interface Handoff {
  id: string;
  patient_id: string;
  type: HandoffType;
  status: HandoffStatus;
  details: Record<string, unknown>;
  source_message_ids: string[];
  created_at: string;
  updated_at: string;
  summary: string;
}

/** What the assistant last asked Alex and is waiting for (persisted on the thread by the server). */
export interface Awaiting {
  kind: string;
  /** The message that asked the question. */
  message_id: string;
  context: Record<string, unknown>;
}

export interface View {
  patient: { name: string; preferred_name: string; phone: string };
  thread: { id: string; phone: string; awaiting: Awaiting | null };
  messages: Message[];
  handoffs: Handoff[];
  now: string;
  /** AI assist switch state, from the server. */
  agent: { llm_available: boolean; llm_enabled: boolean; model: string | null };
}

export interface ScriptStep {
  n: number;
  from: "Clinic" | "Alex";
  input: string;
  expected: string;
}
