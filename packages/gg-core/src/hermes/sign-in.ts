import type { AuthStorage } from "../auth-storage.js";
import type { OAuthLoginCallbacks } from "../oauth/types.js";
import {
  HermesNotInstalledError,
  NOUS_AUTH_KEY,
  hermesNousLoggedIn,
  hermesProxyCredential,
  loginHermesNous,
  resolveHermesBinary,
  type HermesRunOptions,
} from "./runtime.js";

/**
 * "Sign in with Hermes": reuse the Nous Portal sign-in Hermes already holds, or
 * run Hermes's browser sign-in, then record the proxy address. Starting the
 * proxy is the host's job (it must outlive this call and stop with the host).
 */
export async function signInWithHermes(
  auth: Pick<AuthStorage, "setCredentials">,
  callbacks: OAuthLoginCallbacks,
  opts: HermesRunOptions = {},
): Promise<void> {
  const binary = opts.binary ?? resolveHermesBinary(opts.env);
  if (!binary) throw new HermesNotInstalledError();
  const run = { ...opts, binary };
  callbacks.onStatus("Checking your Hermes sign-in…");
  if (!(await hermesNousLoggedIn(run))) {
    callbacks.onStatus("Opening Nous Portal sign-in…");
    await loginHermesNous(callbacks, run);
    if (!(await hermesNousLoggedIn(run))) {
      throw new Error("Nous Portal sign-in didn't finish. Try again.");
    }
  }
  await auth.setCredentials(NOUS_AUTH_KEY, hermesProxyCredential());
}
