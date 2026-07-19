import { initErrorMom } from "@kenkaiiii/error-mom/node";
import appPackage from "../package.json" with { type: "json" };

const server = process.env.ERROR_MOM_SERVER ?? "https://error-mom-production.up.railway.app";
const projectKey =
  process.env.ERROR_MOM_PROJECT_KEY ?? "em_ingest_NE4bT2QTNimTcqZUX15rq7S9qoM7Pk8crQHdJBQQg_0";
const release = process.env.ERROR_MOM_RELEASE ?? appPackage.version;

const errorMom = initErrorMom({
  server,
  projectKey,
  environment: process.env.ERROR_MOM_ENVIRONMENT ?? "production",
  release,
  // Provider, worker, and sidecar failures are captured at application boundaries.
  // Disabling transport capture avoids duplicate usage 429s and expected cancellations.
  captureFailedRequests: false,
});

globalThis.__GG_ERROR_MOM__ = errorMom;
// Subagent workers launch the same entry so each child process initializes its
// own Node SDK before loading any provider or agent code.
process.env.GG_SUBAGENT_WORKER_ENTRY ??= process.argv[1];

try {
  await import("../../packages/ggcoder/dist/app-sidecar.js");
} catch (error) {
  errorMom.captureError(error, {
    level: "fatal",
    culprit: "app-sidecar.bootstrap",
    tags: { process: "app-sidecar" },
  });
  await errorMom.flush();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GG_APP_FATAL ${message}\n`);
  process.exitCode = 1;
}
