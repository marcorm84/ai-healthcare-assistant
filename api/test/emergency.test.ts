import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentInput } from "../src/agent/types.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

const SPEC_TEXT =
  "If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This text line is not monitored continuously and cannot help in an emergency.";

async function setup(reply = "Happy to help.") {
  const calls: AgentInput[] = [];
  const agent: Agent = {
    async respond(input) {
      calls.push(input);
      return { reply, outcome: { kind: "answered" }, awaiting: null };
    },
  };
  const ctx = await createContext({ storeDir: await mkdtemp(path.join(os.tmpdir(), "willow-")) });
  return { ctx, calls, app: createApp(ctx, agent) };
}

const send = (app: ReturnType<typeof createApp>, body: string) => request(app).post("/api/messages").send({ body });

describe("emergency handling (scenario step 11)", () => {
  it("replies with the exact text and nothing else, and never calls the agent", async () => {
    const { app, calls } = await setup();
    const res = await send(app, "I have chest pain and my left arm feels numb");
    expect(res.status).toBe(201);
    expect(res.body.reply.body).toBe(SPEC_TEXT);
    expect(res.body.reply.sender).toBe("agent");
    expect(calls).toHaveLength(0);
    expect(res.body.thread.awaiting).toBeNull();
  });

  it("logs an emergency handoff linked to the message, with the signals and the patient's words", async () => {
    const { app, ctx } = await setup();
    const res = await send(app, "I have chest pain and my left arm feels numb");
    const handoffs = ctx.repos.handoffs.list();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      type: "emergency",
      status: "pending_staff",
      patient_id: "pt_001",
      source_message_ids: [res.body.patient_message.id],
    });
    expect(handoffs[0]!.details).toMatchObject({
      patient_messages: ["I have chest pain and my left arm feels numb"],
    });
    expect((handoffs[0]!.details.signals as string[]).sort()).toEqual(["arm_jaw_numb", "chest_pain"]);
    expect(res.body.patient_message.outcome).toEqual({ kind: "emergency", handoff_id: handoffs[0]!.id });
  });

  it("does not tell Alex that staff will review it", async () => {
    const { app } = await setup();
    const reply: string = (await send(app, "I can't breathe")).body.reply.body;
    expect(reply.toLowerCase()).not.toMatch(/staff|review|get back|clinic will/);
  });

  it("extends the open emergency record instead of creating a second one", async () => {
    const { app, ctx } = await setup();
    const a = await send(app, "my chest hurts");
    const b = await send(app, "now my left arm is numb too");
    expect(b.body.reply.body).toBe(SPEC_TEXT);
    const handoffs = ctx.repos.handoffs.list();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.source_message_ids).toEqual([a.body.patient_message.id, b.body.patient_message.id]);
    expect(handoffs[0]!.details.patient_messages).toHaveLength(2);
    expect((handoffs[0]!.details.signals as string[]).sort()).toEqual(["arm_jaw_numb", "chest_pain"]);
  });

  it("starts a new record once the earlier emergency was handled by staff", async () => {
    const { app, ctx } = await setup();
    await send(app, "my chest hurts");
    await ctx.repos.handoffs.update(ctx.repos.handoffs.list()[0]!.id, { status: "completed" });
    await send(app, "I fainted");
    expect(ctx.repos.handoffs.list().map((h) => h.status)).toEqual(["completed", "pending_staff"]);
  });

  it("still sends the emergency text if the handoff cannot be saved", async () => {
    const { app, ctx } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ctx.repos.handoffs, "create").mockRejectedValue(new Error("disk full"));
    const res = await send(app, "I think I'm having a heart attack");
    expect(res.status).toBe(201);
    expect(res.body.reply.body).toBe(SPEC_TEXT);
    expect(res.body.patient_message.outcome).toEqual({ kind: "emergency" });
  });

  it("takes priority even while a different question is awaiting an answer", async () => {
    const { app, ctx } = await setup();
    await request(app).post("/api/thread/clinic-messages").send({ body: "Would you like us to request a time?", awaiting_kind: "appointment_offer" });
    const res = await send(app, "yes but I have chest pain right now");
    expect(res.body.reply.body).toBe(SPEC_TEXT);
    expect(ctx.repos.handoffs.list()[0]!.type).toBe("emergency");
  });

  it("the next normal message works normally afterwards", async () => {
    const { app, calls } = await setup("We close at 5:00 p.m. Pacific today.");
    await send(app, "chest pain and left arm numb");
    const res = await send(app, "what time do you close today?");
    expect(calls).toHaveLength(1);
    expect(res.body.reply.body).toBe("We close at 5:00 p.m. Pacific today.");
  });

  it("does not raise a false alarm for the other scenario messages", async () => {
    const { app, calls, ctx } = await setup();
    for (const text of ["yes", "is it booked yet?", "my readings have been around 150/95 all week, should I take two pills?"]) {
      await send(app, text);
    }
    expect(calls).toHaveLength(3);
    expect(ctx.repos.handoffs.list()).toEqual([]);
  });
});

describe("reply guard", () => {
  it("replaces an agent reply that gives clinical advice and claims nothing", async () => {
    const { app } = await setup("Yes, you can take two pills if your pressure is high.");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send(app, "should I take two pills?");
    expect(res.body.reply.body).toBe(
      "I'm not able to help with that here. You can call the clinic at (555) 010-0100 during business hours.",
    );
  });

  it("replaces a reply that invents a review deadline or claims a booking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["Staff will review this within 24 hours.", "I've booked you for Tuesday."]) {
      const { app } = await setup(bad);
      const res = await send(app, "hello");
      expect(res.body.reply.body).not.toBe(bad);
      expect(res.body.reply.body).toMatch(/not able to help/);
    }
  });
});
