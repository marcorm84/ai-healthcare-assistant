import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createContext } from "../src/context.js";
import { loadSeedData } from "../src/data/seed.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "willow-"));

describe("setup", () => {
  it("loads and validates the supplied data", async () => {
    const seed = await loadSeedData(config.dataDir);
    expect(seed.patient.patient_id).toBe("pt_001");
    expect(seed.openSlots).toHaveLength(4);
    expect(seed.faq).toContain("9:00 a.m.–5:00 p.m. Pacific");
  });

  it("serves /api/health and the clock endpoints", async () => {
    const app = createApp(await createContext({ storeDir: await tmp() }));
    expect((await request(app).get("/api/health")).body).toEqual({ ok: true });

    const initial = await request(app).get("/api/clock");
    expect(initial.body.now).toBe(config.defaultNow);

    const set = await request(app).put("/api/clock").send({ now: "2026-11-07T10:00:00-08:00" });
    expect(set.body.now).toBe("2026-11-07T10:00:00-08:00");

    const bad = await request(app).put("/api/clock").send({ now: "tomorrow" });
    expect(bad.status).toBe(400);

    expect((await request(app).delete("/api/clock")).body.now).toBe(config.defaultNow);
  });
});
