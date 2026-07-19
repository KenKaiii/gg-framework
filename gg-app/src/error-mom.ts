import { initErrorMom } from "@kenkaiiii/error-mom";
import appPackage from "../package.json";

// The project key is write-only (submit errors, read nothing), so committing
// it is safe, like a Sentry DSN. Environment variables remain optional overrides.
const server =
  import.meta.env.VITE_ERROR_MOM_SERVER ?? "https://error-mom-production.up.railway.app";
const projectKey =
  import.meta.env.VITE_ERROR_MOM_PROJECT_KEY ??
  "em_ingest_NE4bT2QTNimTcqZUX15rq7S9qoM7Pk8crQHdJBQQg_0";
const release = import.meta.env.VITE_ERROR_MOM_RELEASE ?? appPackage.version;

export const errorMom = initErrorMom({
  server,
  projectKey,
  environment: import.meta.env.VITE_ERROR_MOM_ENVIRONMENT ?? "production",
  release,
});
