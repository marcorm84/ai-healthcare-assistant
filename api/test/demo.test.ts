import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { STEPS } from "../src/scenario/script.js";
import { clinicLocalToIso } from "../src/time.js";

async function setup() {
  const ctx = await createContext({ storeDir: await mkdtemp(path.join(os.tmpdir(), "willow-")) });
  const app = createApp(ctx);
  return { ctx, app, say: async (body: string) => (await request(app).post("/api/messages").send({ body })).body };
}

describe("clinic wall-clock time -> ISO with offset", () => {
  it.each([
    ["2026-11-04T10:00", "2026-11-04T10:00:00-08:00"], // PST
    ["2026-07-01T10:00", "2026-07-01T10:00:00-07:00"], // PDT
    ["2026-11-01T00:30", "2026-11-01T00:30:00-07:00"], // before DST ends
    ["2026-11-01T03:00", "2026-11-01T03:00:00-08:00"], // after DST ends
    ["2026-03-08T12:00", "2026-03-08T12:00:00-07:00"], // after DST starts
    ["2026-11-07T10:00:30", "2026-11-07T10:00:30-08:00"],
  ])("%s -> %s", (local, iso) => expect(clinicLocalToIso(local)).toBe(iso));

  it.each(["", "tomorrow", "2026-02-30T10:00", "2026-11-07T25:00", "2026-11-07 10:00", "2026-11-07"])("rejects %j", (bad) => {
    expect(clinicLocalToIso(bad)).toBeNull();
  });
});

describe("demo API", () => {
  it("PUT /api/clock accepts local clinic time and rejects junk", async () => {
    const { app } = await setup();
    expect((await request(app).put("/api/clock").send({ local: "2026-11-07T10:00" })).body.now).toBe("2026-11-07T10:00:00-08:00");
    expect((await request(app).get("/api/thread")).body.now).toBe("2026-11-07T10:00:00-08:00");
    expect((await request(app).put("/api/clock").send({ local: "nope" })).status).toBe(400);
    expect((await request(app).put("/api/clock").send({})).status).toBe(400);
  });

  it("GET /api/thread includes the patient's name for the header", async () => {
    const { app } = await setup();
    expect((await request(app).get("/api/thread")).body.patient).toEqual({ name: "Alex Morgan", preferred_name: "Alex", phone: "+1-555-010-0199" });
  });

  it("serves the 12-step script", async () => {
    const { app } = await setup();
    const body = (await request(app).get("/api/demo/script")).body;
    expect(body.steps).toHaveLength(12);
    expect(body.steps).toEqual(JSON.parse(JSON.stringify(STEPS)));
  });

  it("reset wipes the conversation and handoffs and restores the scenario clock", async () => {
    const { app, say, ctx } = await setup();
    await say("can I get a refill on my BP med");
    await request(app).put("/api/clock").send({ local: "2026-11-07T10:00" });
    const res = await request(app).post("/api/demo/reset");
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.handoffs).toEqual([]);
    expect(res.body.now).toBe("2026-11-04T10:00:00-08:00");
    expect(ctx.repos.handoffs.list()).toEqual([]);
    // and the conversation starts fresh and works
    expect((await say("what time do you close today?")).reply.body).toBe("We close at 5:00 p.m. Pacific today (Wednesday).");
  });
});

describe("staff actions on a request (simulated human)", () => {
  async function withRefill() {
    const s = await setup();
    await s.say("can I get a refill on my BP med");
    return { ...s, id: s.ctx.repos.handoffs.list()[0]!.id };
  }

  it("moves pending -> approved -> completed, and the agent then reports the real status", async () => {
    const { app, id, say } = await withRefill();
    const a = await request(app).patch(`/api/handoffs/${id}`).send({ status: "approved" });
    expect(a.status).toBe(200);
    expect(a.body.handoff).toMatchObject({ id, status: "approved" });
    expect((await request(app).get("/api/thread")).body.handoffs[0].status).toBe("approved");
    expect((await request(app).patch(`/api/handoffs/${id}`).send({ status: "completed" })).body.handoff.status).toBe("completed");

    // a staff decision on an appointment request shows up in the agent's answer to "is it booked yet?"
    await say("I need my blood pressure rechecked. Tuesday afternoon works.");
    const apptId = (await request(app).get("/api/thread")).body.handoffs.find((h: { type: string }) => h.type === "appointment_request").id;
    await request(app).patch(`/api/handoffs/${apptId}`).send({ status: "approved" });
    expect((await say("is it booked yet?")).reply.body).toMatch(/^Staff has approved your BP recheck request/);
  });

  it("never reopens a closed request, and rejects unknown ids and statuses", async () => {
    const { app, id } = await withRefill();
    await request(app).patch(`/api/handoffs/${id}`).send({ status: "rejected" });
    expect((await request(app).patch(`/api/handoffs/${id}`).send({ status: "pending_staff" })).status).toBe(409);
    expect((await request(app).patch(`/api/handoffs/${id}`).send({ status: "completed" })).status).toBe(409);
    expect((await request(app).patch("/api/handoffs/ho_nope").send({ status: "approved" })).status).toBe(404);
    expect((await request(app).patch(`/api/handoffs/${id}`).send({ status: "booked" })).status).toBe(400);
  });
});
