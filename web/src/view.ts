import type { Handoff, HandoffStatus, HandoffType, Message } from "./types";

/** Pure view helpers (no React), so the logic that decides what staff and Alex see is testable. */

export const CLINIC_TZ = "America/Los_Angeles";

export type Tone = "ok" | "info" | "pending" | "danger";
export interface Tag {
  label: string;
  tone: Tone;
  handoffId?: string;
}

/** How the assistant handled the message an agent reply answers. */
export function outcomeTag(reply: Message, messages: Message[]): Tag | null {
  const tag = baseTag(reply, messages);
  const via = messages.find((m) => m.id === reply.in_reply_to)?.outcome?.via;
  return tag && via === "llm" ? { ...tag, label: `${tag.label} · AI-assisted` } : tag;
}

function baseTag(reply: Message, messages: Message[]): Tag | null {
  if (reply.sender !== "agent") return null;
  const asked = messages.find((m) => m.id === reply.in_reply_to);
  const o = asked?.outcome;
  if (!o) return null;
  const withId = (t: Tag): Tag => (o.handoff_id ? { ...t, handoffId: o.handoff_id } : t);
  switch (o.kind) {
    case "answered":
      return { label: "Answered by assistant", tone: "ok" };
    case "clarifying":
      return { label: "Asked a follow-up", tone: "info" };
    case "handoff_created":
      return withId({ label: "Sent to staff · pending review", tone: "pending" });
    case "handoff_updated":
      return withId({ label: "Staff request updated", tone: "pending" });
    case "emergency":
      // Only say "logged" when a handoff really exists.
      return o.handoff_id
        ? withId({ label: "Emergency logged for staff", tone: "danger" })
        : { label: "Emergency text sent · NOT logged for staff", tone: "danger" };
  }
}

export function groupHandoffs(handoffs: Handoff[]) {
  const newestFirst = (a: Handoff, b: Handoff) => handoffs.indexOf(b) - handoffs.indexOf(a);
  return {
    awaiting: handoffs.filter((h) => h.status === "pending_staff").sort(newestFirst),
    processed: handoffs.filter((h) => h.status !== "pending_staff").sort(newestFirst),
  };
}

export interface Answered {
  id: string;
  question: string;
  answer: string;
}

/** Questions the assistant answered directly from the record/FAQ (no staff needed). */
export function answeredQuestions(messages: Message[]): Answered[] {
  return messages
    .filter((m) => m.sender === "patient" && m.outcome?.kind === "answered")
    .map((q) => ({
      id: q.id,
      question: q.body,
      answer: messages.find((r) => r.sender === "agent" && r.in_reply_to === q.id)?.body ?? "",
    }));
}

export const TYPE_LABEL: Record<HandoffType, string> = {
  appointment_request: "Appointment request",
  refill: "Refill",
  clinical_question: "Clinical question",
  billing: "Billing",
  other: "Other",
  emergency: "Emergency",
};

export const STATUS_LABEL: Record<HandoffStatus, string> = {
  pending_staff: "pending_staff",
  approved: "approved",
  completed: "completed",
  rejected: "rejected",
};

const FIELD_LABEL: Record<string, string> = {
  reason: "Reason",
  provider: "Provider",
  requested_date: "Date",
  time_window: "Window",
  requested_slot: "Slot",
  patient_note: "Note",
  medication: "Medication",
  dose: "Dose",
  frequency: "Frequency",
  pharmacy: "Pharmacy",
  refills_remaining: "Refills left",
  question: "Question",
  reported_readings: "Readings",
  duration: "Duration",
  related_medication: "Medication",
  balance_amount: "Balance",
  balance_reason: "Balance for",
  signals: "Signals",
  patient_messages: "Said",
  channel: "Channel",
  notes: "Notes",
};

/** The structured fields of a handoff as label/value rows, without the empty ones. */
export function detailRows(h: Handoff): [string, string][] {
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(h.details)) {
    if (value === null || value === undefined || value === "") continue;
    let text: string;
    if (Array.isArray(value)) text = value.join(" · ");
    else if (key === "requested_date") text = formatDay(String(value));
    else if (typeof value === "object") {
      const slot = value as { date?: string; start?: string };
      text = [slot.date ? formatDay(slot.date) : "", slot.start ? formatTime12(slot.start) : ""].filter(Boolean).join(" · ");
    }
    else if (key === "balance_amount") text = `$${Number(value).toFixed(2)}`;
    else text = String(value);
    rows.push([FIELD_LABEL[key] ?? key, text]);
  }
  return rows;
}

/** "Wed, Nov 4, 2026 · 10:00 AM PT" */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, hour: "numeric", minute: "2-digit" }).format(d);
  return `${date} · ${time} PT`;
}

/** Value for <input type="datetime-local">: the clinic's wall-clock time. */
export function toLocalInput(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The scenario step to run next: the first one whose text hasn't been sent yet, in order. */
export function nextStep<T extends { n: number; input: string }>(steps: T[], messages: Message[]): T | undefined {
  const sent = new Set(messages.map((m) => m.body));
  return steps.find((s) => !sent.has(s.input));
}

// ---- Dates and times: one format everywhere, always the clinic's Pacific time ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-11-12" -> "Thu, Nov 12, 2026" (a calendar date, no time zone involved). */
export function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "14:00" -> "2:00 PM" */
export function formatTime12(hhmm: string): string {
  const [h = 0, min = "00"] = hhmm.split(":");
  const hour = Number(h);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${min} ${hour < 12 ? "AM" : "PM"}`;
}

/** What the picker value ("2026-11-07T10:00", clinic wall time) will become, in the same format as the clock. */
export function formatLocalInput(local: string): string {
  const [date, time] = local.split("T");
  if (!date || !time) return "";
  return `${formatDay(date)} · ${formatTime12(time.slice(0, 5))} PT`;
}

// ---- US date entry for the demo clock (MM/DD/YYYY h:mm AM/PM), independent of the browser's locale ----

/** "2026-11-07T10:00" -> "11/07/2026 10:00 AM" */
export function formatUsDateTime(local: string): string {
  const [date, time] = local.split("T");
  const [y, m, d] = (date ?? "").split("-");
  if (!y || !m || !d || !time) return "";
  return `${m}/${d}/${y} ${formatTime12(time.slice(0, 5))}`;
}

/**
 * Parses "11/7/2026 9:05 pm", "11/07/2026 10:00 AM" or 24h "11/07/2026 14:30" into "2026-11-07T21:05".
 * Returns null for anything that is not a real date and time.
 */
export function parseUsDateTime(text: string): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(text);
  if (!m) return null;
  const [month, day, year, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5])];
  let hour = Number(m[4]);
  if (m[6]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[6].toLowerCase().startsWith("p") ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}
