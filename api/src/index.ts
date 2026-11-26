import { createApp } from "./app.js";
import { config } from "./config.js";
import { createContext } from "./context.js";

const ctx = await createContext(); // fails fast on invalid seed data or a corrupt store
const app = createApp(ctx);

app.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port} (patient: ${ctx.seed.patient.name}, now: ${ctx.clock.now()})`);
});
