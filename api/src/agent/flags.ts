/**
 * Ablation switches for the evals. `current` is the real agent. `baseline` turns OFF the three
 * fixes the variations suite forced (see docs/evidence.md) so the eval can show a
 * before/after on the same cases. Nothing else reads them; production always runs `current`.
 */
export const flags = {
  /** A date, weekday or time of day is never taken as the reason for an appointment. */
  dateNeverReason: true,
  /** "the following Monday" is relative to the request being changed (or the agent asks). */
  followingAnchor: true,
  /** A medication from the record plus a need for more of it is a refill ("need more lisinopril"). */
  medNeedRefill: true,
};

export type Variant = "current" | "baseline";

export function setVariant(v: Variant) {
  const on = v === "current";
  flags.dateNeverReason = on;
  flags.followingAnchor = on;
  flags.medNeedRefill = on;
}
