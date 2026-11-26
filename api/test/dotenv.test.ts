import { describe, expect, it } from "vitest";
import { parseDotEnv } from "../src/config.js";

describe(".env parsing", () => {
  it("reads KEY=VALUE, strips quotes and spaces, ignores comments and empty values", () => {
    const parsed = parseDotEnv(`# a comment
OPENAI_API_KEY=sk-abc123
OPENAI_MODEL = "gpt-4o-mini"
AGENT_LLM='on'
EMPTY=
  # indented comment
NOT A LINE
`);
    expect(parsed).toEqual({ OPENAI_API_KEY: "sk-abc123", OPENAI_MODEL: "gpt-4o-mini", AGENT_LLM: "on" });
  });
  it("the shipped .env.example has an empty key, so copying it enables nothing by accident", async () => {
    const { readFileSync } = await import("node:fs");
    const example = parseDotEnv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));
    expect(example.OPENAI_API_KEY).toBeUndefined();
    expect(example.AGENT_LLM).toBe("off");
  });
});
