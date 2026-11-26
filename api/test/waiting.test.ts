import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScenarioDriver } from "../src/scenario/driver.js";

/** What the assistant is waiting on Alex for is saved on the thread (`thread.awaiting`); the agent relies on it to understand a bare "yes". */
describe("what the assistant is waiting on Alex for is persisted state", () => {
  async function withDriver(run: (d: ScenarioDriver) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "willow-waiting-"));
    const d = await ScenarioDriver.start(dir);
    try {
      await run(d);
    } finally {
      await d.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("the Aetna offer is exposed, is not a handoff, survives a restart, and clears when Alex answers", async () => {
    await withDriver(async (d) => {
      const turn = await d.send("do you take Aetna?");
      let v = await d.view();
      expect(v.handoffs).toEqual([]); // an offer is not a request to staff
      expect(v.thread.awaiting).toMatchObject({ kind: "pass_to_staff", message_id: turn.reply.id, context: { reason: "insurance_question", question: "do you take Aetna?" } });

      await d.restart(); // still there after a restart, pointing at the same question
      v = await d.view();
      expect(v.thread.awaiting).toMatchObject({ kind: "pass_to_staff", message_id: turn.reply.id });
      expect(v.messages.find((m) => m.id === v.thread.awaiting!.message_id)!.body).toMatch(/pass your question to staff\?$/);

      await d.send("what time do you close today?"); // Alex moves on: the offer lapses
      expect((await d.view()).thread.awaiting).toBeNull();
      expect((await d.view()).handoffs).toEqual([]);
    });
  });

  it('answering "yes" resolves it into a real handoff and clears the wait', async () => {
    await withDriver(async (d) => {
      await d.send("do you take Aetna?");
      await d.send("yes");
      const v = await d.view();
      expect(v.thread.awaiting).toBeNull();
      expect(v.handoffs.map((h) => `${h.type}/${h.status}`)).toEqual(["other/pending_staff"]);
    });
  });

  it("an appointment question in progress shows what was already noted, and nothing is filed yet", async () => {
    await withDriver(async (d) => {
      await d.send("I'd like an appointment Tuesday afternoon");
      const v = await d.view();
      expect(v.handoffs).toEqual([]);
      expect(v.thread.awaiting).toMatchObject({ kind: "appointment_time", context: { missing: "reason", window: "afternoon" } });
    });
  });
});
