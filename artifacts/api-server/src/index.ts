import app from "./app";
import { ensureDiseaseCodeCatalog } from "./lib/disease-code-catalog";
import { logger } from "./lib/logger";
import { purgeOldSecurityEvents } from "./lib/security-events";
import { purgeExpiredRevocations } from "./lib/medichain-auth";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  await ensureDiseaseCodeCatalog();
  // Security events are kept for 12 months.
  // Revocations are only needed until the revoked tokens would have expired.
  const purge = () => Promise.all([purgeOldSecurityEvents(), purgeExpiredRevocations()]).catch((err: unknown) => logger.error({ err }, "Old security records could not be deleted"));
  void purge();
  setInterval(purge, 24 * 60 * 60_000).unref();
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

void start().catch((err: unknown) => {
  logger.error({ err }, "Unable to initialize the API server");
  process.exit(1);
});
