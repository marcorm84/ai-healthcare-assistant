import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/context.js";
import type { State } from "../src/domain/schemas.js";
import { JsonStore } from "../src/store/jsonStore.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "willow-"));
const PHONE = "+1-555-010-0199";

describe("persistence", () => {
  it("keeps threads, messages, handoffs, awaiting state and the clock after a restart", async () => {
    const dir = await tmp();
    const a = await createContext({ storeDir: dir });

    const thread = await a.repos.threads.getOrCreate("pt_001", PHONE);
    const m0 = await a.repos.messages.append({ thread_id: thread.id, sender: "clinic", body: "Hi Alex" });
    await a.repos.threads.setAwaiting(thread.id, { kind: "appointment_offer", message_id: m0.id, context: {} });
    const m1 = await a.repos.messages.append({ thread_id: thread.id, sender: "patient", body: "yes", in_reply_to: m0.id });
    const h = await a.repos.handoffs.create({
      patient_id: "pt_001",
      type: "appointment_request",
      details: { reason: "BP recheck" },
      source_message_ids: [m1.id],
    });
    await a.clock.set("2026-11-06T09:00:00-08:00");

    // "restart": brand-new context reading the same files
    const b = await createContext({ storeDir: dir });
    const again = await b.repos.threads.getOrCreate("pt_001", PHONE);
    expect(again.id).toBe(thread.id); // same conversation continues
    expect(again.awaiting?.message_id).toBe(m0.id);
    expect(b.repos.messages.listByThread(thread.id).map((m) => m.body)).toEqual(["Hi Alex", "yes"]);
    expect(b.repos.messages.get(m1.id)?.in_reply_to).toBe(m0.id);
    expect(b.repos.handoffs.get(h.id)).toMatchObject({ status: "pending_staff", type: "appointment_request" });
    expect(b.clock.now()).toBe("2026-11-06T09:00:00-08:00");
  });

  it("updates a handoff in place: merges details, appends sources, keeps one record", async () => {
    const ctx = await createContext({ storeDir: await tmp() });
    const t = await ctx.repos.threads.getOrCreate("pt_001", PHONE);
    const m1 = await ctx.repos.messages.append({ thread_id: t.id, sender: "patient", body: "Tuesday afternoon" });
    const m2 = await ctx.repos.messages.append({ thread_id: t.id, sender: "patient", body: "Thursday instead" });
    const h = await ctx.repos.handoffs.create({
      patient_id: "pt_001",
      type: "appointment_request",
      details: { date: "2026-11-10", window: "afternoon" },
      source_message_ids: [m1.id],
    });
    const updated = await ctx.repos.handoffs.update(h.id, { details: { date: "2026-11-12" }, source_message_id: m2.id });
    await ctx.repos.handoffs.update(h.id, { source_message_id: m2.id }); // idempotent

    expect(updated.details).toEqual({ date: "2026-11-12", window: "afternoon" });
    expect(ctx.repos.handoffs.get(h.id)?.source_message_ids).toEqual([m1.id, m2.id]);
    expect(ctx.repos.handoffs.list()).toHaveLength(1);
  });

  it("rejects replies that point at a message outside the thread", async () => {
    const ctx = await createContext({ storeDir: await tmp() });
    const t = await ctx.repos.threads.getOrCreate("pt_001", PHONE);
    await expect(
      ctx.repos.messages.append({ thread_id: t.id, sender: "patient", body: "yes", in_reply_to: "msg_nope" }),
    ).rejects.toThrow(/in_reply_to/);
    expect(ctx.repos.messages.listByThread(t.id)).toHaveLength(0);
  });

  it("serializes concurrent writes without losing any", async () => {
    const ctx = await createContext({ storeDir: await tmp() });
    const t = await ctx.repos.threads.getOrCreate("pt_001", PHONE);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        ctx.repos.messages.append({ thread_id: t.id, sender: "patient", body: `m${i}` }),
      ),
    );
    expect(ctx.repos.messages.listByThread(t.id).map((m) => m.body)).toEqual(
      Array.from({ length: 25 }, (_, i) => `m${i}`),
    );
  });

  it("a failed update changes neither memory nor disk, and the next write still works", async () => {
    const dir = await tmp();
    const ctx = await createContext({ storeDir: dir });
    await expect(
      ctx.store.update((s) => {
        s.threads.push({ id: "bad" } as never); // fails schema validation
      }),
    ).rejects.toThrow();
    await expect(
      ctx.store.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(ctx.store.read().threads).toHaveLength(0);
    const onDisk = JSON.parse(await readFile(path.join(dir, "db.json"), "utf8")) as State;
    expect(onDisk.threads).toHaveLength(0);

    await ctx.repos.threads.getOrCreate("pt_001", PHONE);
    expect(ctx.store.read().threads).toHaveLength(1);
  });

  it("writes atomically: no temp file is left behind and the file is valid JSON", async () => {
    const dir = await tmp();
    const ctx = await createContext({ storeDir: dir });
    await ctx.repos.threads.getOrCreate("pt_001", PHONE);
    expect(await readdir(dir)).toEqual(["db.json"]);
    expect(() => JSON.parse(readFileSync(path.join(dir, "db.json"), "utf8"))).not.toThrow();
  });

  it("refuses to start on a corrupt store instead of overwriting it", async () => {
    const dir = await tmp();
    const file = path.join(dir, "db.json");
    await writeFile(file, "{ not json");
    await expect(createContext({ storeDir: dir })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{ not json");

    await writeFile(file, JSON.stringify({ version: 1 }));
    await expect(JsonStore.open(file, () => ({}) as never)).rejects.toThrow();
  });
});
