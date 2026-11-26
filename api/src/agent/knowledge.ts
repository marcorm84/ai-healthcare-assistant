import { parseHours, type Hours } from "./hours.js";

/** The clinic FAQ as structured entries. The FAQ is the only source of truth for policy. */
export interface Knowledge {
  hours: Hours;
  /** Entry text by lowercase label, e.g. get("address"). Undefined = the FAQ doesn't cover it. */
  get(label: string): string | undefined;
  /** Payment URL from the "Paying a balance" entry. */
  payUrl: string | undefined;
}

export function parseFaq(markdown: string): Knowledge {
  const entries = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const m = /^\s*[-*•●]\s*([^:]+):\s*(.+?)\s*$/.exec(line);
    if (m) entries.set(m[1]!.trim().toLowerCase(), m[2]!);
  }
  const hoursText = entries.get("hours");
  if (!hoursText) throw new Error("The FAQ has no 'Hours' entry");
  const pay = entries.get("paying a balance");
  return {
    hours: parseHours(hoursText),
    get: (label) => entries.get(label.toLowerCase()),
    payUrl: pay ? /https?:\/\/[^\s,;]+/.exec(pay)?.[0]?.replace(/[.)]+$/, "") : undefined,
  };
}
