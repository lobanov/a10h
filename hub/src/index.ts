import { migrate } from "./db.ts";
import { createHttpServer } from "./api.ts";
import { tick } from "./scheduler.ts";
import { agentConfig } from "./agents.ts";

/**
 * Hub entrypoint: migrate, start HTTP, run the scheduler tick loop.
 */
const PORT = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  await migrate();
  const cfg = agentConfig();
  console.log(
    `[hub] agents ${cfg.enabled ? `enabled (auditor=${cfg.auditorModel}, director=${cfg.directorModel})` : `DISABLED: ${cfg.reason}`}`,
  );
  const server = createHttpServer();
  server.listen(PORT, () => console.log(`[hub] listening on :${PORT}`));

  const TICK_MS = 2_000;
  const timer = setInterval(() => {
    void tick().catch((e) => console.error("[hub] tick error:", e.message));
  }, TICK_MS);

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[hub] fatal:", e);
  process.exit(1);
});
