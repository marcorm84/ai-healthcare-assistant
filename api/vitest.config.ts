import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { OPENAI_API_KEY: "", AGENT_LLM: "off" } },
});
