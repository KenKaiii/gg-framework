import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeCanonicalUrl } from "./notes-reference";

export type OpenReferenceUrl = (url: string) => Promise<void>;

export const openReferenceUrl: OpenReferenceUrl = async (url) => {
  const canonicalUrl = normalizeCanonicalUrl(url);
  if (!canonicalUrl) {
    throw new TypeError(
      "Reference URL must be an absolute HTTP(S) URL without a username or password.",
    );
  }
  await openUrl(canonicalUrl);
};
