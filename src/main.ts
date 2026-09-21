// Entrypoint: `npm start` runs dist/main.js.
import { main } from "./server.ts";

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
