import type { Clock } from "../clock.js";
import type { SeedData } from "../data/seed.js";
import type { Handoff, HandoffStatus, HandoffType } from "../domain/schemas.js";
import type { Repositories } from "../store/repositories.js";
import { clinicDate } from "../time.js";
import { HANDOFF_DEFS, type HandoffEnv } from "./registry.js";

export type HandoffErrorCode = "invalid_details" | "not_found" | "not_open" | "invalid_transition";

export class HandoffError extends Error {
  constructor(
    readonly code: HandoffErrorCode,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}: ${issues.join("; ")}` : message);
    this.name = "HandoffError";
  }
}

export type HandoffAction = "created" | "updated" | "unchanged";

/**
 * The only way requests are created or changed. Validates details per type,
 * keeps one record per request (dedupe), and never touches closed records.
 * It records requests; it never books, approves or changes the clinical record.
 */
export class HandoffService {
  constructor(
    private readonly repos: Repositories,
    private readonly seed: SeedData,
    private readonly clock: Clock,
  ) {}

  private env(): HandoffEnv {
    return { patient: this.seed.patient, openSlots: this.seed.openSlots, today: clinicDate(this.clock.now()) };
  }

  /** Parse + cross-check a full details object. Returns the normalized details. */
  private validate(type: HandoffType, details: unknown): Record<string, unknown> {
    const def = HANDOFF_DEFS[type];
    const parsed = def.detailsSchema.safeParse(details);
    if (!parsed.success) {
      throw new HandoffError(
        "invalid_details",
        `Invalid ${type} details`,
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    const problem = def.check?.(parsed.data, this.env());
    if (problem) throw new HandoffError("invalid_details", `Invalid ${type} details`, [problem]);
    return parsed.data;
  }

  /** The open (pending_staff) request that `details` would duplicate, if any. */
  findOpenDuplicate(patientId: string, type: HandoffType, details: Record<string, unknown>): Handoff | undefined {
    const def = HANDOFF_DEFS[type];
    if (!def.dedupeKey) return undefined;
    const key = def.dedupeKey(details);
    return this.repos.handoffs
      .listByPatient(patientId)
      .find((h) => h.type === type && h.status === "pending_staff" && def.dedupeKey!(h.details) === key);
  }

  /**
   * Create a request, or update the open one it duplicates. Use this when the
   * agent has the full details; use `update` to change one specific request.
   */
  async upsert(input: {
    patientId: string;
    type: HandoffType;
    details: Record<string, unknown>;
    sourceMessageId: string;
  }): Promise<{ handoff: Handoff; action: HandoffAction }> {
    const details = this.validate(input.type, input.details);
    const open = this.findOpenDuplicate(input.patientId, input.type, details);
    if (open) {
      const merged = HANDOFF_DEFS[input.type].merge?.(open.details, details) ?? details;
      return this.apply(open, merged, input.sourceMessageId);
    }
    const handoff = await this.repos.handoffs.create({
      patient_id: input.patientId,
      type: input.type,
      details,
      source_message_ids: [input.sourceMessageId],
    });
    return { handoff, action: "created" };
  }

  /** Change an existing open request (e.g. new date, same window). Fields not in `patch` are kept. */
  async update(
    id: string,
    patch: Record<string, unknown>,
    sourceMessageId: string,
  ): Promise<{ handoff: Handoff; action: HandoffAction }> {
    const existing = this.repos.handoffs.get(id);
    if (!existing) throw new HandoffError("not_found", `Handoff ${id} not found`);
    this.assertOpen(existing);
    const def = HANDOFF_DEFS[existing.type];
    const merged = def.merge ? def.merge(existing.details, patch) : { ...existing.details, ...patch };
    return this.apply(existing, merged, sourceMessageId);
  }

  private async apply(
    existing: Handoff,
    nextDetails: Record<string, unknown>,
    sourceMessageId: string,
  ): Promise<{ handoff: Handoff; action: HandoffAction }> {
    this.assertOpen(existing);
    const details = this.validate(existing.type, nextDetails);
    const unchanged =
      JSON.stringify(details) === JSON.stringify(existing.details) && existing.source_message_ids.includes(sourceMessageId);
    if (unchanged) return { handoff: existing, action: "unchanged" }; // safe to retry
    const handoff = await this.repos.handoffs.update(existing.id, { details, source_message_id: sourceMessageId });
    return { handoff, action: "updated" };
  }

  private assertOpen(h: Handoff) {
    if (h.status !== "pending_staff") {
      throw new HandoffError("not_open", `Handoff ${h.id} is ${h.status}; staff already acted on it`);
    }
  }

  /**
   * A *staff* action (never the agent's): record what staff decided. Only moves forward;
   * a closed request stays closed.
   */
  async setStatus(id: string, status: HandoffStatus): Promise<Handoff> {
    const existing = this.repos.handoffs.get(id);
    if (!existing) throw new HandoffError("not_found", `Handoff ${id} not found`);
    const allowed: Record<HandoffStatus, HandoffStatus[]> = {
      pending_staff: ["approved", "completed", "rejected"],
      approved: ["completed", "rejected"],
      completed: [],
      rejected: [],
    };
    if (!allowed[existing.status].includes(status)) {
      throw new HandoffError("invalid_transition", `Cannot change a ${existing.status} request to ${status}`);
    }
    return this.repos.handoffs.update(id, { status });
  }

  /** The patient's open requests of a type (e.g. to find the appointment request to update). */
  findOpen(patientId: string, type: HandoffType): Handoff[] {
    return this.repos.handoffs.listByPatient(patientId).filter((h) => h.type === type && h.status === "pending_staff");
  }

  summarize(h: Handoff): string {
    return HANDOFF_DEFS[h.type].summarize(h.details);
  }
}
