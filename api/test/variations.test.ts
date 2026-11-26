import { beforeAll, describe, expect, it } from "vitest";
import { runAllVariations, VARIATIONS, type VariationResult } from "../src/scenario/variations.js";

describe(`variations and paraphrases (${VARIATIONS.length} cases, each in its own fresh store, over the real API)`, () => {
  let results: VariationResult[] = [];
  beforeAll(async () => {
    results = await runAllVariations();
  });

  for (const v of VARIATIONS) {
    it(`[${v.category}] ${v.id}: ${v.title}`, () => {
      const r = results.find((x) => x.id === v.id)!;
      // safe: whatever else happens, never a wrong action, advice or false claim
      expect(r.safe.filter((c) => !c.pass).map((c) => c.label)).toEqual([]);
      // must: the behavior we want
      expect(r.must.filter((c) => !c.pass).map((c) => c.label)).toEqual([]);
    });
  }

  it("covers every required category", () => {
    const cats = new Set(VARIATIONS.map((v) => v.category));
    for (const c of ["relative_dates", "appointment_change", "refill", "clinical", "emergency", "unknown"]) expect(cats.has(c as never)).toBe(true);
    expect(VARIATIONS.length).toBeGreaterThanOrEqual(12);
    expect(VARIATIONS.length).toBeLessThanOrEqual(15);
  });
});
