/**
 * Imported FIRST by the eval and scenario runners (before config.ts is evaluated), so that a key in
 * .env can never make the reproducible evidence call OpenAI by accident. Pass --llm to the eval to
 * opt in on purpose.
 */
if (process.argv.includes("--llm")) {
  process.env.AGENT_LLM = "on";
} else {
  process.env.AGENT_LLM = "off";
  process.env.OPENAI_API_KEY = "";
}
