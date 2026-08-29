import { createApp } from "./app";
import { env } from "./config/env";

const app = createApp();

app.listen(env.port, () => {
  console.log(`InvoMatch server listening on http://localhost:${env.port} (${env.nodeEnv})`);
});
