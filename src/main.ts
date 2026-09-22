// Entrypoint: `npm start` runs dist/main.js.
import { redactUrls } from "./sender.ts";
import { main } from "./server.ts";

main().catch((e: unknown) => {
  // Never print the raw error: viem messages embed the RPC URL, which may carry a token.
  console.error(redactUrls(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  process.exit(1);
});
