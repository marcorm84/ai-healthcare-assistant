import { readFile } from "node:fs/promises";
import path from "node:path";
import { OpenSlotsSchema, PatientSchema, type OpenSlot, type Patient } from "../domain/schemas.js";

export interface SeedData {
  patient: Patient;
  faq: string;
  openSlots: OpenSlot[];
}

/** Loads and validates the supplied synthetic data. Fails loudly on bad shape. */
export async function loadSeedData(dataDir: string): Promise<SeedData> {
  const read = (f: string) => readFile(path.join(dataDir, f), "utf8");
  const [patientRaw, faq, slotsRaw] = await Promise.all([
    read("alex_morgan.json"),
    read("clinic_faq.md"),
    read("open_slots.json"),
  ]);
  return {
    patient: PatientSchema.parse(JSON.parse(patientRaw)),
    faq,
    openSlots: OpenSlotsSchema.parse(JSON.parse(slotsRaw)),
  };
}
