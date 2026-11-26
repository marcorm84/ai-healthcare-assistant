import type { AppContext } from "../context.js";
import type { Handoff, OpenSlot } from "../domain/schemas.js";
import { clinicDate } from "../time.js";
import type { Knowledge } from "./knowledge.js";
import { statusAt, type OpenStatus } from "./hours.js";

/**
 * Read-only tools: the agent's only window onto patient data, the FAQ, the
 * calendar and request status. There is deliberately nothing here that books,
 * approves or edits the clinical record.
 */
export function createReadTools(ctx: AppContext, knowledge: Knowledge) {
  const { patient } = ctx.seed;
  const today = () => clinicDate(ctx.clock.now());

  return {
    patient,
    knowledge,
    today,
    openStatus: (): OpenStatus => statusAt(knowledge.hours, ctx.clock.now()),

    /** The soonest *booked* appointment from today on. Pending requests are not appointments. */
    nextBookedAppointment() {
      return patient.upcoming_appointments
        .filter((a) => a.status === "booked" && a.date >= today())
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    },

    /** The patient's most recent open appointment request (a request, never a booking). */
    openAppointmentRequest: (): Handoff | undefined =>
      ctx.handoffs.findOpen(patient.patient_id, "appointment_request").at(-1),

    /** The most recent appointment request in any status, to report what staff did with it. */
    latestAppointmentRequest: (): Handoff | undefined =>
      ctx.repos.handoffs.listByPatient(patient.patient_id).filter((h) => h.type === "appointment_request").at(-1),

    /** Open slots from tomorrow on, in the order we show them. Read-only: never reserved. */
    futureOpenSlots: (): OpenSlot[] =>
      ctx.seed.openSlots
        .filter((s) => s.date > today())
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)),

    balance: () => patient.balance,
  };
}

export type ReadTools = ReturnType<typeof createReadTools>;
