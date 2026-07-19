import { initErrorMom } from "@kenkaiiii/error-mom";

const server = import.meta.env.VITE_ERROR_MOM_SERVER;
const projectKey = import.meta.env.VITE_ERROR_MOM_PROJECT_KEY;
const release = import.meta.env.VITE_ERROR_MOM_RELEASE;

// Capture is optional: builds without Error Mom env vars simply skip monitoring
// instead of crashing the app at startup.
if (server && projectKey) {
  initErrorMom({
    server,
    projectKey,
    environment: import.meta.env.VITE_ERROR_MOM_ENVIRONMENT ?? "production",
    ...(release ? { release } : {}),
  });
}
