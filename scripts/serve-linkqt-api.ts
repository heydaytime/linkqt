import { handleLinkqtRequest } from "../lib/server/linkqt-api";

const port = Number(process.env.LINKQT_API_PORT ?? 4010);
Bun.serve({
  port,
  idleTimeout: 180,
  fetch: handleLinkqtRequest,
});
console.log(`LinkQT API listening on http://localhost:${port}`);
