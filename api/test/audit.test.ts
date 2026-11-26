import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { loadSeedData } from "../src/data/seed.js";
import { auditConversation } from "../src/scenario/audit.js";
import { ScenarioDriver, type View } from "../src/scenario/driver.js";
import { runScript } from "../src/scenario/checks.js";
import { runAllVariations } from "../src/scenario/variations.js";

const seed = await loadSeedData(config.dataDir);

describe("avoidable staff follow-ups on the evaluated conversations", () => {
  it("the 12-step demo script: 4 handoffs audited, 0 avoidable follow-ups", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "willow-audit-"));
    const driver = await ScenarioDriver.start(dir);
    try {
      const { final } = await runScript(driver, { before: async (n) => (n === 6 ? driver.restart() : undefined) });
      const audit = auditConversation(final, seed);
      expect(audit.handoffsAudited).toBe(4);
      expect(audit.findings).toEqual([]);
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("every variation conversation: 0 avoidable follow-ups", async () => {
    const results = await runAllVariations();
    const all = results.flatMap((r) => auditConversation(r.view, seed).findings.map((f) => ({ id: r.id, ...f })));
    expect(all).toEqual([]);
    expect(results.reduce((n, r) => n + auditConversation(r.view, seed).handoffsAudited, 0)).toBeGreaterThanOrEqual(12);
  });
});

// A "0" only means something if the audit can see a problem. Break a good conversation on purpose.
describe("the audit really detects what counts as an avoidable follow-up", () => {
  async function goodView(): Promise<View> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "willow-audit-"));
    const driver = await ScenarioDriver.start(dir);
    try {
      const { final } = await runScript(driver);
      return structuredClone(final);
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  const h = (v: View, type: string) => v.handoffs.find((x) => x.type === type)!;
  const kinds = (v: View) => auditConversation(v, seed).findings.map((f) => f.kind);

  it("missed detail: a refill without the pharmacy", async () => {
    const v = await goodView();
    h(v, "refill").details.pharmacy = null;
    expect(auditConversation(v, seed).findings.map((f) => `${f.kind}`)).toContain("missed_detail");
  });
  it("missed detail: a clinical question that dropped the reading, the duration or the medication", async () => {
    for (const field of ["reported_readings", "duration", "related_medication"]) {
      const v = await goodView();
      h(v, "clinical_question").details[field] = null;
      expect(kinds(v), field).toContain("missed_detail");
    }
  });
  it("missed detail: an appointment with no reason or window", async () => {
    for (const field of ["reason", "time_window"]) {
      const v = await goodView();
      h(v, "appointment_request").details[field] = "";
      expect(kinds(v), field).toContain("missed_detail");
    }
  });
  it("incorrect record: a reason that is really a date word (a misread reason)", async () => {
    for (const reason of ["tuesday", "next friday", "tomorrow", "following monday"]) {
      const v = await goodView();
      h(v, "appointment_request").details.reason = reason;
      expect(kinds(v), reason).toContain("incorrect_record");
    }
  });
  it("duplicate request: a second open appointment request for the same reason", async () => {
    const v = await goodView();
    v.handoffs.push({ ...structuredClone(h(v, "appointment_request")), id: "ho_dup" });
    expect(kinds(v)).toContain("duplicate_request");
  });
  it("incorrect record: wrong dose, wrong refills count, wrong pharmacy, an invented medication", async () => {
    for (const [field, value] of [["dose", "20 mg"], ["refills_remaining", 3], ["pharmacy", "CVS"], ["medication", "Metformin"]] as const) {
      const v = await goodView();
      h(v, "refill").details[field] = value;
      expect(kinds(v), field).toContain("incorrect_record");
    }
  });
  it("incorrect record: an appointment in the past, on a weekend, with a slot that isn't open, or with the wrong provider", async () => {
    const edits: [string, Record<string, unknown>][] = [
      ["past", { requested_date: "2026-11-03" }],
      ["weekend", { requested_date: "2026-11-14" }],
      ["not an open slot", { requested_slot: { date: "2026-11-12", start: "10:00", provider: "Dr. Priya Lee" } }],
      ["wrong provider", { provider: "Dr. Somebody Else" }],
    ];
    for (const [label, patch] of edits) {
      const v = await goodView();
      Object.assign(h(v, "appointment_request").details, patch);
      expect(kinds(v), label).toContain("incorrect_record");
    }
  });
  it("incorrect record: a source link to a message that doesn't exist or isn't Alex's", async () => {
    const v = await goodView();
    h(v, "refill").source_message_ids = ["msg_nope"];
    expect(kinds(v)).toContain("incorrect_record");
    const v2 = await goodView();
    h(v2, "refill").source_message_ids = [v2.messages.find((m) => m.sender === "agent")!.id];
    expect(kinds(v2)).toContain("incorrect_record");
  });
  it("asked Alex for something we already know", async () => {
    const v = await goodView();
    const a = v.messages.find((m) => m.sender === "agent")!;
    a.body = "Sure. Which pharmacy do you use?";
    expect(kinds(v)).toContain("asked_known_info");
    const v2 = await goodView();
    const b = v2.messages.filter((m) => m.sender === "agent")[0]!;
    b.body = "What's the appointment for?"; // the clinic's own outbound already said blood pressure
    expect(kinds(v2)).toContain("asked_known_info");
  });
  it("a clean conversation has no findings (so the checks above are not just always-on)", async () => {
    expect(auditConversation(await goodView(), seed).findings).toEqual([]);
  });
});
