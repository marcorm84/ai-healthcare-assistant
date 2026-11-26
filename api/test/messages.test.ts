import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentDecision, AgentInput } from "../src/agent/types.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "willow-"));

/** Scripted agent so these tests cover thread mechanics, not agent logic. */
function scripted(fn: (input: AgentInput) => AgentDecision | Promise<AgentDecision>): Agent & { calls: AgentInput[] } {
  const calls: AgentInput[] = [];
  return {
    calls,
    async respond(input) {
      calls.push(input);
      return fn(input);
    },
  };
}

const STEP0 = "Hi Alex, this is Willow Family Clinic. Would you like us to request a time for you?";

async function setup(agent: Agent, storeDir?: string) {
  const ctx = await createContext({ storeDir: storeDir ?? (await tmp()) });
  return { ctx, app: createApp(ctx, agent) };
}

describe("thread API", () => {
  it("saves the clinic's outbound message and shows it in the thread", async () => {
    const { app } = await setup(scripted(() => ({ reply: "x", awaiting: null })));
    const res = await request(app).post("/api/thread/clinic-messages").send({ body: STEP0, awaiting_kind: "appointment_offer" });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ sender: "clinic", body: STEP0, in_reply_to: null });
    expect(res.body.thread.awaiting).toMatchObject({ kind: "appointment_offer", message_id: res.body.message.id });

    const thread = (await request(app).get("/api/thread")).body;
    expect(thread.messages).toHaveLength(1);
    expect(thread.handoffs).toEqual([]);
    expect(thread.thread.phone).toBe("+1-555-010-0199");
  });

  it('matches a bare "yes" to the clinic message that is awaiting a reply', async () => {
    const agent = scripted(() => ({ reply: "When works for you?", awaiting: null }));
    const { app } = await setup(agent);
    const m0 = (await request(app).post("/api/thread/clinic-messages").send({ body: STEP0, awaiting_kind: "appointment_offer" })).body.message;

    const res = await request(app).post("/api/messages").send({ body: "yes" });
    expect(res.status).toBe(201);
    expect(res.body.patient_message.in_reply_to).toBe(m0.id);
    expect(res.body.reply).toMatchObject({ sender: "agent", in_reply_to: res.body.patient_message.id });

    // The agent saw the matched message, what was awaiting, and the full history.
    const seen = agent.calls[0]!;
    expect(seen.replyTo?.id).toBe(m0.id);
    expect(seen.awaiting?.kind).toBe("appointment_offer");
    expect(seen.history.map((m) => m.body)).toEqual([STEP0, "yes"]);
    expect(seen.now).toBe("2026-11-04T10:00:00-08:00");
  });

  it("without anything awaiting, matches the reply to the latest clinic/agent message", async () => {
    const { app } = await setup(scripted(() => ({ reply: "ok", awaiting: null })));
    await request(app).post("/api/thread/clinic-messages").send({ body: STEP0 }); // no awaiting
    const first = (await request(app).post("/api/messages").send({ body: "hello" })).body;
    const second = (await request(app).post("/api/messages").send({ body: "and?" })).body;
    expect(first.patient_message.in_reply_to).toBeTruthy();
    expect(second.patient_message.in_reply_to).toBe(first.reply.id); // the agent's reply, not the earlier patient message
  });

  it("lets the agent set what the next message is awaiting, pointing at its own reply", async () => {
    const agent = scripted((i) =>
      i.awaiting
        ? { reply: "Done", outcome: { kind: "answered" }, awaiting: null }
        : { reply: "Pass it to staff?", awaiting: { kind: "pass_to_staff", context: { q: "Aetna" } } },
    );
    const { app } = await setup(agent);
    const a = (await request(app).post("/api/messages").send({ body: "do you take Aetna?" })).body;
    expect(a.thread.awaiting).toEqual({ kind: "pass_to_staff", message_id: a.reply.id, context: { q: "Aetna" } });

    const b = (await request(app).post("/api/messages").send({ body: "yes" })).body;
    expect(b.patient_message.in_reply_to).toBe(a.reply.id);
    expect(b.patient_message.outcome).toEqual({ kind: "answered" });
    expect(b.thread.awaiting).toBeNull(); // cleared once consumed
  });

  it("rejects empty or oversized bodies and stores nothing", async () => {
    const agent = scripted(() => ({ reply: "x", awaiting: null }));
    const { app } = await setup(agent);
    for (const body of ["", "   ", "x".repeat(2001), undefined, 42]) {
      expect((await request(app).post("/api/messages").send({ body })).status).toBe(400);
    }
    expect((await request(app).post("/api/thread/clinic-messages").send({ body: " " })).status).toBe(400);
    expect((await request(app).get("/api/thread")).body.messages).toEqual([]);
    expect(agent.calls).toHaveLength(0);
  });

  it("keeps the inbound message and tells Alex honestly (503) when the agent fails; the thread keeps working", async () => {
    let fail = true;
    const agent = scripted(() => {
      if (fail) throw new Error("agent exploded");
      return { reply: "back", awaiting: null };
    });
    const { app } = await setup(agent);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).post("/api/messages").send({ body: "hello" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "not_saved", reply_text: expect.stringContaining("can't confirm that anything was recorded") });
    expect((await request(app).get("/api/thread")).body.messages.map((m: { body: string }) => m.body)).toEqual(["hello"]);

    fail = false;
    expect((await request(app).post("/api/messages").send({ body: "hello again" })).status).toBe(201);
  });

  it("handles simultaneous inbound messages one at a time, in order", async () => {
    let active = 0;
    let maxActive = 0;
    const agent = scripted(async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { reply: `re: ${i.message.body}`, awaiting: null };
    });
    const { app } = await setup(agent);
    await Promise.all(["a", "b", "c"].map((body) => request(app).post("/api/messages").send({ body })));

    expect(maxActive).toBe(1);
    const bodies = (await request(app).get("/api/thread")).body.messages.map((m: { body: string }) => m.body);
    expect(bodies).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) expect(bodies[i + 1]).toBe(`re: ${bodies[i]}`); // each reply follows its own message
  });

  it("continues the same conversation after a restart", async () => {
    const dir = await tmp();
    const agent = scripted(() => ({ reply: "When works for you?", awaiting: { kind: "appointment_time" } }));
    const a = await setup(agent, dir);
    await request(a.app).post("/api/thread/clinic-messages").send({ body: STEP0, awaiting_kind: "appointment_offer" });
    const turn = (await request(a.app).post("/api/messages").send({ body: "yes" })).body;

    // New process: fresh context and app over the same files.
    const agent2 = scripted(() => ({ reply: "ok", awaiting: null }));
    const b = await setup(agent2, dir);
    const thread = (await request(b.app).get("/api/thread")).body;
    expect(thread.messages.map((m: { sender: string }) => m.sender)).toEqual(["clinic", "patient", "agent"]);
    expect(thread.thread.awaiting).toMatchObject({ kind: "appointment_time", message_id: turn.reply.id });

    const next = (await request(b.app).post("/api/messages").send({ body: "Tuesday afternoon works" })).body;
    expect(next.patient_message.in_reply_to).toBe(turn.reply.id);
    expect(agent2.calls[0]!.history).toHaveLength(4); // all earlier turns survived the restart
  });
});
